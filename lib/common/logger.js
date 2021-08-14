(function (root, factory) {
    'use strict'
    if (typeof define === 'function' && define.amd) define([], factory)
    else if (typeof exports === 'object') module.exports = factory()
    else root.Logger = factory()
}(this, function () {
    var StringUtil = function () {
        return {
            format: function (n, r) {
                return n.replace(/\{(\d+)\}/g, function (n, t) {
                    return typeof r[t] != "undefined" ? r[t] : n
                })
            },
            hashCode: function (n) {
                if (typeof n != "string") return "not string";
                var r = 0;
                if (n.length === 0) return r;
                for (i = 0; i < n.length; i++) {
                    r = (r << 5) - r + n.charCodeAt(i);
                    r = r & r
                }
                return r
            }
        }
    }()

    var getStackTrace = function () {
        var obj = {};
        Error.captureStackTrace(obj, getStackTrace);
        return obj.stack;
    }

    const formatNumber = n => {
        n = n.toString()
        return n[1] ? n : '0' + n
    }

    const formatTime = date => {
        const year = date.getFullYear()
        const month = date.getMonth() + 1
        const day = date.getDate()
        const hour = date.getHours()
        const minute = date.getMinutes()
        const second = date.getSeconds()
        const millisecond = date.getMilliseconds()
        return [year, month, day].map(formatNumber).join('-') + ' ' + [hour, minute, second].map(formatNumber).join(':') + '.' + millisecond
    }

    var Logger = function (isLog) {
        var now = new Date;
        var dev, prod, logModel;
        if (typeof window !== "undefined") {
            var logType = ["debug", "info", "warn", "error"];
            var f = ["assert", "dir", "dirxml", "group", "groupEnd", "time", "timeEnd", "count", "trace", "profile", "profileEnd"];
            if (!window.console) {
                window.console = {}
            }
            if (!window.console.log) {
                window.console.log = function () { }
            }
            for (var i = 0; i < f.length; ++i) {
                if (!window.console[f[i]]) {
                    window.console[f[i]] = function () { }
                }
            }
            for (var i = 0; i < logType.length; ++i) {
                if (!window.console[logType[i]]) {
                    window.console[logType[i]] = window.console.log
                }
            }
        }
        dev = {
            DEBUG: function (msg) {
                var time = formatTime(new Date())
                var stack = getStackTrace()
                var fileno = stack.split('\n')[5].split(/[()]/)[1]
                console.debug(fileno, time, msg) // 这里如果上面初始化失败不能使用可直接将这里改为 console.log
            },
            INFO: function (msg) {
                var time = formatTime(new Date())
                var stack = getStackTrace()
                var fileno = stack.split('\n')[5].split(/[()]/)[1]
                console.debug(fileno, time, msg)
            },
            WARN: function (msg) {
                var time = formatTime(new Date())
                var stack = getStackTrace()
                var fileno = stack.split('\n')[5].split(/[()]/)[1]
                console.debug(fileno, time, msg)
            },
            ERROR: function (msg) {
                var time = formatTime(new Date())
                var stack = getStackTrace()
                var fileno = stack.split('\n')[5].split(/[()]/)[1]
                console.debug(fileno, time, msg)
            }
        };
        //生产环境中使用任需要打印日志可在这里做相应的修改
        prod = {
            DEBUG: function (msg) { }, INFO: function (msg) { }, WARN: function (msg) { }, ERROR: function (msg) { }
        };
        logModel = isLog ? dev : prod;
        var s;
        var u;
        var c = [];
        var oldDate = now;

        function l(n) {
            var newDate = new Date;
            var timeStamp = newDate - oldDate;
            var message = timeStamp > 150 ? timeStamp + "(ms): " + n.msg : n.msg;
            try {
                logModel[n.type](message)
            } catch (e) {
                return
            }
            oldDate = newDate;
        }

        function d(n) {
            if (Object.prototype.toString.call(n) === "[object Array]") {
                var o = "[";
                for (var r = 0; r < n.length; r++) {
                    o = o + d(n[r]) + ","
                }
                return o + "]"
            } else {
                return StringUtil.hashCode(n)
            }
        }

        function w(n) {
            if (n.length == 0) return null;
            var r = [];
            for (var t = 0; t < n.length; t++) {
                var i = n[t];
                r.push(typeof i == "object" ? JSON.stringify(i) : i)
            }
            return r.join(" ")
        }

        function v(logType, o) {
            var r = {
                type: logType,
                msg: w(o)
            };
            l(r);
            if (u == undefined) {
                c.push(r)
            } else if (u && u.passwords) {
                c.push(r);
                var t = u.passwords;
                for (var i = 0; i < t.length; i++) {
                    var e = t[i];
                    if ("password".indexOf(e) != -1) {
                        continue
                    }
                    if (r.msg.indexOf(e) != -1) {
                        var f = "audit fail for: " + e;
                        l({
                            type: "ERROR",
                            msg: f
                        });
                        throw f
                    }
                }
            }
        }

        return {
            setLogging: function (isLogging) {
                logModel = isLogging ? dev : prod
            }, skipAudit: function () {
                l({
                    type: "DEBUG",
                    msg: w(arguments)
                })
            }, debug: function () {
                v("DEBUG", arguments)
            }, info: function () {
                v("INFO", arguments)
            }, warn: function () {
                v("WARN", arguments)
            }, error: function () {
                v("ERROR", arguments)
            }, getAuditString: function () {
                var n = [];
                for (var o = 0; o < c.length; o++) {
                    var r = c[o];
                    n.push(r.type + ":" + r.msg)
                }
                return n.join("\n")
            }, init: function (flag) {
                u = flag;
                if (u === false) {
                    c = []
                }
            }
        }
    };

    return Logger
}))