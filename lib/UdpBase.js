/**
 * wx.createUDPSocket
 */
(function (root, factory) {
    'use strict'
    if (typeof define === 'function' && define.amd) define([], factory)
    else if (typeof exports === 'object') module.exports = factory()
    else root.UdpBase = factory()
}(this, function () {
    'use strict'

    const errors = require('./errors')
    const Errors = errors.Errors
    const EUDPSUPPORT = errors.EUDPSUPPORT
    const EUDPCREATE = errors.EUDPCREATE
    const EUDPBIND = errors.EUDPBIND
    class UdpBase {
        constructor(port) {
            this.New(port);
            this._init();
        }
        New(port) {
            this.udpCreater = null
            try {
                this._env = "node"
                const dgram = require('dgram')
                this.udpCreater = dgram.createSocket
            } catch (e) {
                if (typeof wx != 'undefined' && typeof wx.createUDPSocket !== 'function') {
                    throw Errors(EUDPSUPPORT, "create udp socket error!!!");
                } else {
                    this._env = "wx"
                    this.udpCreater = wx.createUDPSocket
                }
            }
            try {
                console.log(this.udpCreater)
                this.kudper = this.udpCreater('udp4');
                if (this.kudper) {
                    this.kudper.bind(port, () => {
                        this.kudper.setBroadcast(true); /* callback 仅 nodejs 有效 */
                    });
                } else {
                    throw Errors(EUDPBIND, "udp bind socket error!!!");
                }
            } catch (e) {
                console.error("createUDPSocket:", e);
                throw Errors(EUDPCREATE, "create udp socket error!!!");
            }
        }
        onClose() {
            return new Promise((resolver) => {
                if (this._env == "node") {
                    this.kudper.on("close", function (res) {
                        console.info("onClose: ", res);
                        resolver({
                            message: res.message,
                            IPinfo: res.remoteInfo,
                        });
                    })
                } else {
                    this.kudper.onClose(function (res) {
                        console.info("onClose: ", res);
                        resolver({
                            message: res.message,
                            IPinfo: res.remoteInfo,
                        });
                    });
                }
            });
        }
        offClose() {
            return new Promise((resolver) => {
                if (this._env == "node") {
                    this.kudper.on("close", function (res) {
                        console.info("onClose: ", res);
                        resolver({
                            message: res.message,
                            IPinfo: res.remoteInfo,
                        });
                    })
                } else {
                    this.kudper.offClose(function (res) {
                        console.info("offClose: ", res);
                        resolver({
                            message: res.message,
                            IPinfo: res.remoteInfo,
                        });
                    });
                }
            });
        }
        onError() {
            return new Promise((resolver) => {
                if (this._env == "node") {
                    this.kudper.on("error", function (res) {
                        console.info("onError: ", res)
                        this.kudper.close()
                    })
                } else {
                    this.kudper.onError(function (res) {
                        console.error("onError: ", res);
                        this.kudper.close()
                    });
                }
            });
        }
        offError() {
            return new Promise((resolver) => {
                if (this._env == "node") {
                    this.kudper.on("error", function (res) {
                        console.info("offError: ", res);
                        this.kudper.close()
                    })
                } else {
                    this.kudper.offError(function (res) {
                        console.error("offError: ", res);
                        this.kudper.close()
                    });
                }
            });
        }
        onListening() {
            return new Promise((resolver) => {
                if (this._env == "node") {
                    this.kudper.on("listening", () => {
                        const info = this.kudper.address()
                        console.log(`server listening ${info.address}:${info.port}`);
                    })
                } else {
                    this.kudper.onListening(function (res) {
                        resolver({
                            message: res.message,
                            IPinfo: res.remoteInfo,
                        });
                    });
                }
            });
        }
        offListening() {
            let self = this;
            return new Promise((resolver) => {
                if (this._env == "node") {
                    console.log("node offListening")
                } else {
                    this.kudper.offListening(function (res) {
                        self.onError();
                        self.offError();
                        resolver({
                            message: res.message,
                            IPinfo: res.remoteInfo,
                        });
                    });
                }
            });
        }
        offMessage() {
            return new Promise(() => {
                if (this._env == "node") {
                    console.log("node offMessage")
                } else {
                    this.kudper.offMessage(function () { });
                }
            });
        }
        onMessage() {
            if (this._env == "node") {
                this.kudper.on("message", (msg, rinfo) => {
                    console.log(msg, rinfo)
                    var { address, port } = rinfo
                    this._onMessageHandler(address, port, msg);
                })
            } else {
                this.kudper.onMessage((res) => {
                    var rinfo = res.remoteInfo
                    var { address, port } = rinfo
                    var msg = res.message
                    this._onMessageHandler(address, port, msg);
                })
            }
        }
        write(ip, port, msg) {
            if (this._env == "node") {
                var msgTA = new Uint8Array(msg);
                this.kudper.send(msgTA, port, ip)
            } else {
                return this.kudper.send({ address: ip, port: port, message: msg });
            }
        }
        // 初始化udp相关回调
        _init() {
            if (this.kudper) {
                this.onListening();
                this.offListening();
                this.onMessage();
                this.offMessage();
                this.onClose();
                this.offClose();
            }
        }
    }

    return UdpBase
}))