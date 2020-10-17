/**
 * Tks https://github.com/husa/timer.js
 * 
 * Simple and lightweight library without any dependencies to create and manage, well, timers.
 */
(function (root, factory) {
    'use strict'
    if (typeof define === 'function' && define.amd) define([], factory)
    else if (typeof exports === 'object') module.exports = factory()
    else root.Timer = factory()
}(this, function () {
    'use strict'

    var defaultOptions = {
        tick: 1,         // set specific tick(e.g. you can set it to 2, then your ontick handler will fire every 2 seconds)
        onstart: null,   // start event handler
        onrestart: null, // restart event handler, stop and start        
        ontick: null,    // what to do on every tick
        onpause: null,   // pause event handler
        onstop: null,    // stop event handler
        onend: null      // end event handler(when Timer stops without interrupt)
    }

    var Timer = function (options, ...args) {
        if (!(this instanceof Timer)) return new Timer(options)
        this._ = {
            id: +new Date + Math.floor(Math.random() * 10000), // 1000 ID generate in one millisecond
            options: {},                                       // different status callback & config
            duration: 0,                                       // timer left duration
            _duration: 0,                                      // timer duration
            status: 'initialized',                             // timer last status
            start: 0,                                          // timer start time
            restart: 0,                                        // timer restart time
            measures: [],
            args: args                                         // call env args
        }
        for (var prop in defaultOptions) this._.options[prop] = defaultOptions[prop]
        this.options(options)
    }

    // starts a Timer for a specified time
    Timer.prototype.start = function (duration) {
        if (!+duration && !this._.duration) return this
        // duration && (duration *= 1000)
        duration && (duration *= 1)
        if (this._.timeout && this._.status === 'started') return this
        this._.duration = duration || this._.duration
        this._._duration = this._.duration
        this._.timeout = setTimeout(end.bind(this), this._.duration)
        if (typeof this._.options.ontick === 'function') {
            this._.interval = setInterval(function () {
                trigger.call(this, 'ontick', this.getDuration(), ...this._.args)
            }.bind(this), ++this._.options.tick * 1 /*+this._.options.tick * 1000*/)
        }
        this._.start = +new Date
        this._.status = 'started'
        trigger.call(this, 'onstart', this.getDuration(), ...this._.args)
        return this
    }

    // restarts a Timer for a specified time
    Timer.prototype.restart = function (duration) {
        clear.call(this, true)
        // duration && (duration *= 1000)
        duration && (duration *= 1)
        this._.duration = duration || this._._duration
        this._.timeout = setTimeout(end.bind(this), this._.duration)
        if (typeof this._.options.ontick === 'function') {
            this._.interval = setInterval(function () {
                trigger.call(this, 'ontick', this.getDuration(), ...this._.args)
            }.bind(this), ++this._.options.tick * 1 /*+this._.options.tick * 1000*/)
        }
        this._.restart = +new Date
        this._.status = 'started' // 'restarted'
        trigger.call(this, 'onrestart', this.getDuration(), ...this._.args)
        return this
    }

    // after pause you can continue the job by myTimer.start()
    Timer.prototype.pause = function () {
        if (this._.status !== 'started') return this
        this._.duration -= (+new Date - this._.start)
        clear.call(this, false)
        this._.status = 'paused'
        trigger.call(this, 'onpause', this.getDuration(), ...this._.args)
        return this
    }

    // to stop timer doing his job
    Timer.prototype.stop = function () {
        if (!/started|paused|restarted/.test(this._.status)) return this
        clear.call(this, true)
        this._.status = 'stopped'
        trigger.call(this, 'onstop', this.getDuration(), ...this._.args)
        return this
    }

    // get remaining time(in ms)
    Timer.prototype.getDuration = function () {
        if (this._.status === 'started')
            return this._.duration - (+new Date - this._.start)
        if (this._.status === 'paused') return this._.duration
        return 0
    }

    // get current status of timer. Available statuses are: 'initialized', 'started', 'paused', 'stopped'
    Timer.prototype.getStatus = function () {
        return this._.status
    }

    /** 
     * define multiple specific options at once as an object
     * You can use .off('all') to restore all previously defined options to defaults
     */
    Timer.prototype.options = function (option, value) {
        if (option && value) this._.options[option] = value
        if (!value && typeof option === 'object') {
            for (var prop in option) {
                if (this._.options.hasOwnProperty(prop))
                    this._.options[prop] = option[prop]
            }
        }
        return this
    }

    /**
     * set some specific option, support options without 'on' prefix. Available options are : 
     *  tick, ontick, start, onstart, end, onend, stop, onstop, pause, onpause
     */
    Timer.prototype.on = function (option, value) {
        if (typeof option !== 'string' || typeof value !== 'function') return this
        if (!(/^on/).test(option))
            option = 'on' + option
        if (this._.options.hasOwnProperty(option))
            this._.options[option] = value
        return this
    }

    // similar to 'on()' but it will remove handler
    Timer.prototype.off = function (option) {
        if (typeof option !== 'string') return this
        option = option.toLowerCase()
        if (option === 'all') {
            this._.options = defaultOptions
            return this
        }
        if (!(/^on/).test(option)) option = 'on' + option
        if (this._.options.hasOwnProperty(option))
            this._.options[option] = defaultOptions[option]
        return this
    }

    /**
     * Start a high-performance measurement with an associated label, 
     * you need to use the same label to stop measurement, so make sure you've saved it
     */
    Timer.prototype.measureStart = function (label) {
        this._.measures[label || ''] = +new Date
        return this
    }

    /**
     * Stop the measument with the associated label, returns the numbers of elapsed ms
     * Note! '' (empty string) equals to absence of argument, and it is valid
     *     timer.measureStart();
     *     // some operations
     *     timer.measureStop();
     */
    Timer.prototype.measureStop = function (label) {
        return +new Date - this._.measures[label || '']
    }

    function end() {
        clear.call(this)
        this._.status = 'stopped'
        trigger.call(this, 'onend', ...this._.args)
    }

    function trigger(event) {
        var callback = this._.options[event],
            args = [].slice.call(arguments, 1)
        typeof callback === 'function' && callback.apply(this, args)
    }

    function clear(clearDuration) {
        clearTimeout(this._.timeout)
        clearInterval(this._.interval)
        if (clearDuration === true) this._.duration = 0
    }

    return Timer
}))
