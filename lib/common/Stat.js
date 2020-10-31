/**
 * stat some info
 */
(function (root, factory) {
    'use strict'
    if (typeof define === 'function' && define.amd) define([], factory)
    else if (typeof exports === 'object') module.exports = factory()
    else root.Stat = factory()
}(this, function () {
    'use strict'
    class Stat {
        constructor() {
            this.props = {}
        }
        incr(key, v) {
            return this.props[key] ? this.props[key] += (v || 1) : this.props[key] = (v || 1);
        }
        decr(key) {
            return this.props[key] ? this.props[key]-- : this.props[key] = 0;
        }
        set(key, val) {
            return this.props[key] ? this.props[key] = val || 0 : this.props[key] = val || 0;
        }
        del(key) {
            delete this.props[key];
        }
        get(key) {
            return this.props[key];
        }
        avg(key, val) {
            if (!this.props[key]) {
                this.props[key] = 0;
                this.props[key + "_cnt"] = 1;
                this.props[key] += ((val || 0) - this.props[key]) / this.props[key + "_cnt"];
            } else {
                this.props[key] += ((val || 0) - this.props[key]) / ++this.props[key + "_cnt"];
                this.props[key] = parseFloat(this.props[key].toFixed(2));
            }
        }
    }
    return Stat
}))
