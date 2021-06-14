/**
 * wx.createUDPSocket
 */
import { Errors, EUDPSUPPORT, EUDPCREATE, EUDPBIND, } from './errors';

(function (root, factory) {
    'use strict'
    if (typeof define === 'function' && define.amd) define([], factory)
    else if (typeof exports === 'object') module.exports = factory()
    else root.UdpBase = factory()
}(this, function () {
    'use strict'

    class UdpBase {
        constructor(port) {
            this.create(port);
        }
        create(port) {
            if (typeof wx.createUDPSocket !== 'function') {
                throw Errors(EUDPSUPPORT, "udp socket is not support!!!");
            }
            try {
                this.kudper = wx.createUDPSocket();
                if (this.kudper) {
                    this.kudper.bind(port);
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
                this.kudper.onClose(function (res) {
                    console.info("onClose: ", res);
                    resolver({
                        message: res.message,
                        IPinfo: res.remoteInfo,
                    });
                });
            });
        }
        offClose() {
            return new Promise((resolver) => {
                this.kudper.offClose(function (res) {
                    console.info("offClose: ", res);
                    resolver({
                        message: res.message,
                        IPinfo: res.remoteInfo,
                    });
                });
            });
        }
        onError() {
            return new Promise((resolver) => {
                this.kudper.onError(function (res) {
                    console.error("onError: ", res);
                    resolver({
                        message: res.message,
                        IPinfo: res.remoteInfo,
                    });
                });
            });
        }
        offError() {
            return new Promise((resolver) => {
                this.kudper.offError(function (res) {
                    console.error("offError: ", res);
                    resolver({
                        message: res.message,
                        IPinfo: res.remoteInfo,
                    });
                });
            });
        }
        onListening() {
            return new Promise((resolver) => {
                this.kudper.onListening(function (res) {
                    resolver({
                        message: res.message,
                        IPinfo: res.remoteInfo,
                    });
                });
            });
        }
        offListening() {
            let self = this;
            return new Promise((resolver) => {
                this.kudper.offListening(function (res) {
                    self.onError();
                    self.offError();
                    resolver({
                        message: res.message,
                        IPinfo: res.remoteInfo,
                    });
                });
            });
        }
        offMessage() {
            return new Promise(() => {
                this.kudper.offMessage(function () { });
            });
        }
        onMessage() {
            let self = this;
            self.kudper.onMessage(function (res) {
                self._onMessageHandler(res);
            });
        }
        send(ip, port, msg) {
            return this.kudper.send({ address: ip, port: port, message: msg });
        }
    }

    return UdpBase
}))