#!/usr/bin/env node
"use strict";

/*
 * Hammer - A simple WebSocket-based chat server & client written in JavaScript.
 *
 * Copyright (C) 2023 Hammer Authors <chrono@disilla.org>
 */

// check that we're running Node.js 18 or higher
if (parseInt(process.versions.node.split(".")[0]) < 18) {
	console.log("Error: Hammer requires Node.js 18 or higher!");
	process.exit(1);
}

// servers
const { Server } = require("ws");
const express = require("express");
const cors = require("cors");

// utilities
const path = require("path");
require("dotenv").config();

// import external deps
const jwt = require("jsonwebtoken");
const db = require("./db/dbAPI");
const { getUserById } = require("./db/users");
const { Banner } = require("./cmd");

// prompt the user for the port
const port = process.argv[2] || 8080;

// internal routers
const auth = require("./auth/auth").router;
const api = require("./api/api").router;

// create a new websocket server
const wss = new Server({ port: port });
const app = express();

// import com from api
const com = require("./api/api").communicator;

// import Message data structure
const { Message } = require("./structures/structures");

// allow CORS
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// listen for connections
wss.on("connection", (ws, req) => {
	var url = new URL(req.url, `http://${req.headers.host}`);
	var token = url.searchParams.get("token");
	ws.json = (data) => {
		ws.send(JSON.stringify(data));
	};

	// check that token was provided
	if (!token) {
		return ws.close();
	}

	// check that the connection is an authorized user
	var auth = db.checkTokenAuth(token);

	// if the connection is not authorized, close the connection
	if (auth == false) {
		return ws.close();
	} else {
		// see if the user is already connected
		var user = db.getUserByToken(token);

		// if the user is already connected, close the connection
		if (user.socket) {
			// log that the user is already connected
			console.log(`User ${user.username} is already connected!`);

			return ws.close();
		}

		// send authorized handshake
		ws.json({
			op: 10,
			data: { message: "Authorized" },
			type: "HELLO"
		});
	}

	var username;
	// get the username from the token
	try {
		username = jwt.verify(token, process.env.JWT_SECRET).username;
	} catch (err) {
		// set username to "Unknown"
		username = "Unknown";
	}

	// console.log that we've received a connection
	console.log(`Received connection from ${username}!`);

	// get the user from the database
	var user = db.getUserByToken(token);

	// set the user's token & socket
	user.token = token;
	user.socket = ws;

	console.log(`User ${username} has joined the server!`);
	// handshake complete variable
	var handshakeComplete = false;

	ws.on("message", (message) => {
		try { // try to parse the message
			message = JSON.parse(message);
		} catch (err) { // if the message fails to parse, close the connection
			console.log(`Error parsing message from ${username}!`);
			console.log(err);

			// close the connection
			return ws.close();
		}

		// check if the handshake is complete
		if (!handshakeComplete) {
			// await falken identify payload
			if (message.op == 11 && message.type == "IDENTIFY") {
				// set the heartbeat interval
				setInterval(() => {
					// send the heartbeat
					ws.json(({
						op: 1,
						data: null,
						type: "HEARTBEAT"
					}));
				}, message.data.heartbeat_interval);

				// send the identify ack
				ws.json(({
					op: 12,
					data: {},
					type: "READY"
				}));

				// set handshake complete to true
				return handshakeComplete = true;
			}

			// else, close the connection
			else {
				// log that we're rejecting an improper handshake
				console.log(`Rejected improper handshake from ${username}!`);

				// close the connection
				return ws.close();
			}
		} else if (handshakeComplete) {
			// handle heartbeat
			if (message.op == 11 && message.type == "HEARTBEAT_ACK") {
				// we don't need to do anything here, the client is just acknowledging the heartbeat
				return;
			}

			// check if it's a non-zero opcode
			if (message.op == 0) {
				// verify that channel is provided
				if (!message.data.channel) {
					console.log(`${username} requested to join a channel but didn't provide one!`);

					ws.json(({
						op: 9,
						data: {
							message: "You've sent a message without a channel!"
						},
						type: "ERROR"
					}));
					return;
				}

				// verify that the channel exists
				if (!db.channels.has(message.data.channel)) {
					console.log(`${username} requested non-existant channel!`);

					ws.json({
						op: 9,
						data: {
							message: "That channel does not exist!"
						},
						type: "ERROR"
					});
					return;
				}

				// verify that the user is actually in the channel requested
				if (!db.channels.get(message.data.channel).members.has(user.id)) {
					console.log(`${username} requested to join a channel they're not in!`);

					return ws.json(({
						op: 9,
						data: {
							message: "You are not in that channel!"
						},
						type: "ERROR"
					}));
				}
			}

			// update current sock channel
			var channel = db.channels.get(message.data.channel);

			// switch on the op code 0-9, empty blocks
			switch (message.op) {
				case 0: // message
					// check if the message is empty
					if (message.data.message == "") {
						// return send error that the message is empty
						return ws.json(({
							op: 9,
							data: {
								message: "You can't send an empty message!"
							},
							type: "ERROR"
						}));
					}

					// construct the message
					var msg = new Message(message.data.content, user.id, db.channels.get(message.data.channel));

					// send message
					channel.sendAll(msg);
					break;
				case 1: // update user status / activity
					// verify that the status is valid
					if (message.data.status < 0 || message.data.status > 4) {
						ws.json(({
							op: 9,
							data: {
								message: "Invalid status!"
							},
							type: "ERROR"
						}));
						return;
					}
					break;
				case 9: // client thinks we had an error
					console.error(`Client ${username} thinks we had an error!`);
					break;
				default:
					console.error(`Client ${username} sent an invalid op code!`);
					break;
			}
		}
	});

	ws.on("close", () => {
		// remove the user's socket, if it exists
		if (user.socket) {
			user.socket = null;
		}

		// remove the user's token, if it exists
		if (user.token) {
			user.token = null;
		}
	});
});

// channel join event
com.on("channelJoin", (obj) => {
	let { user, channel } = obj;

	// get the channel from the database
	user = getUserById(user);
	channel = db.getChannelById(channel);

	// send the channel join message
	user.socket.json(({
		op: 0,
		data: {
			channel: channel,
		},
		type: "CHANNEL_JOIN"
	}));

	// send the channel join message
	user.socket.json(({
		op: 0,
		data: {
			channel: channel,
			author: "SYSTEM",
			content: `${user.username} has joined the channel!`
		},
		type: "MESSAGE"
	}));
});

// channel leave event
com.on("channelLeave", (obj) => {
	let { user, channel } = obj;

	// get the channel from the database
	user = db.getUserById(user);

	// send the channel join message
	user.socket.json(({
		op: 0,
		data: {
			channel: db.getChannelById(channel),
		},
		type: "CHANNEL_LEAVE"
	}));
});

// update user event
com.on("updateUser", (obj) => {
	let { user } = obj;

	// get the user from the database
	user = db.getUserById(user);

	// find every channel the user is in
	for (let channel of user.channels) {
		// log channel name
		console.log(channel.name);
	}
});

// authentication router
app.use("/auth", auth);

// api router
app.use("/api", api);

// // app router
app.use("/app", express.static(path.join(__dirname, "./app")));

// // login router
app.use("/app/login", express.static(path.join(__dirname, "./app/login.html")));

// start the server
let listener = app.listen(`${new Number(port) + 1}`, function () {
	Banner();

	console.log(`Gateway listening on port http://localhost:${wss.address().port}`);
	console.log("Server API is listening on port http://localhost:" + listener.address().port);
});

db.addUser("admin@disilla.org", "admin", "password", {
	ADMINISTRATOR: true,
	MANAGE_CHANNELS: true,
	MANAGE_MESSAGES: true
}).then((user) => {
	db.createChannel({ name: "general", description: "The general channel" }, user.id).then((channel) => {
		db.addUserToChannel(channel.id, user.id).catch((err) => {
			console.log(err);
		});
		db.addUser("me@disilla.org", "chrono", "password", {
			ADMINISTRATOR: false,
			MANAGE_CHANNELS: false,
			MANAGE_MESSAGES: false
		}).then((nuser) => {
			db.addUserToChannel(channel.id, nuser.id).catch((err) => {
				console.log(err);
			});
		}).catch((err) => {
			console.log(err);
		});
	}).catch((err) => {
		console.log(err);
	});
}).catch((err) => {
	console.log(err);
});
