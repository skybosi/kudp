/**
 * 1. 一段时间内UDP传输过程中的seq资源的分配、消费管理；
 * 2. 一段时间内UDP传输过程中的数据包状态管理
 *     - 数据包控制位的设置与解析
 *     - 数据包数据传输状态的管理
 */
import { Errors, ENOTALLOCISN, } from './errors';
import { SEP, } from './constant';

(function (root, factory) {
  'use strict'
  if (typeof define === 'function' && define.amd) define([], factory)
  else if (typeof exports === 'object') module.exports = factory()
  else root.sendQueue = factory()
}(this, function () {
  const timer = require('./common/timer')

  class SendBuffer {
    constructor(cap, task, isn, cb, ctx) {
      this._cap = cap;    // 最大容量
      this._isn = isn || 0;
      this._task = task;
      this._cb = cb;
      this._ctx = ctx;
      this.init(isn);
    }

    get cap() { return this._cap; }
    get size() { return this._size; }
    get ctx() { return this._ctx; }
    empty() { return 0 == this._size; }
    full() { return this._cap == this._size; }

    init(isn) {
      this._pool = {};     // 发送缓冲区
      this._lo = 0;        // 当前循环轮次
      this._size = 0;      // 当前发送池子大小
      this._cursor = isn;  // 当前连续的已被读取起始下标
    }

    push(pos, data) {
      if (this.full()) {
        return -1;
      }
      let cursor = pos - this._isn;
      let index = [cursor, this._lo, this._isn].join(SEP)
      if (!this._pool[index]) {
        this._pool[index] = data;
        this._size++;
      }
      return 0;
    }

    /**
     * 释放 this._cursor -> pos 的数据
     * TODO 是否考虑回绕
     * @param {*} pos 
     * @param {*} cb 
     */
    free(pos, cb) {
      if (pos < this._cursor) {
        return;
      }
      for (let i = this._cursor, delta = pos - this._cursor; i <= pos; i++) {
        let index = [(i - this._isn), this._lo, this._isn].join(SEP)
        if (this._pool[index]) {
          typeof cb === 'function' && cb(this._pool[index], delta);
          delete this._pool[index];
          this._size--;
        };
      }
      this._cursor = (0 >= this._size) ? this._isn : pos + 1;
    }

    /**
     * 在发送缓冲去释放某个数据
     * @param {*} pos 
     * @param {*} cb 
     */
    del(pos, cb) {
      let index = [(pos - this._isn), this._lo, this._isn].join(SEP);
      if (this._pool[index]) {
        typeof cb === 'function' && cb(this._pool[index]);
        delete this._pool[index];
        this._size--;
      };
      this._cursor = (0 >= this._size) ? this._isn : pos + 1;
    }

    /**
     * 遍历所有的发送缓冲区中的数据
     * @param {*} cb 
     */
    each(cb) {
      for (let index in this._pool) {
        if (typeof cb === 'function' && this._pool[index]) {
          cb(this._pool[index]);
        };
      }
    }
  }

  class sendQueue {
    constructor(ip, port, meta) {
      this._cap = 256
      this._meta = meta || {}
      this._meta['ip'] = ip
      this._meta['port'] = port
      this._size = 0
      this.queue = {}
    }

    get cap() { return this._cap }

    get size() { return this._size }

    get meta() { return this._meta }

    get ip() { return this._meta['ip'] }

    get port() { return this._meta['port'] }

    /**
     * 在发送队列新增一个task任务及初始化发送缓冲区
     * @param {*} task 
     * @param {*} buffcap 
     * @param {*} data 
     * @param {*} timeOutCb 
     */
    insert(task, isn, buffcap, data, timeOutCb) {
      if (this._size >= this._cap) {
        return null
      }
      let taskTimer = new timer(
        {
          onend: (args) => {
            timeOutCb(...args)
          },
          onstop: (...args) => {
            console.info("timeout", ...args)
          }
        }, [task, this.ip, this.port]
      );
      this.queue[task] = {}
      this.queue[task]['meta'] = this._meta
      taskTimer.setArgs({ done: 0, timeout: 0 });
      this.queue[task]['Q'] = new SendBuffer(buffcap, task, isn, null, data); // 创建发送缓冲器
      this.queue[task]['Q'].push(isn, data)
      this.queue[task]['timer'] = taskTimer
      this._size++
      return this.queue[task]
    }

    /**
     * 发送完成后，在合适的时候释放该task的相关资源
     * @param {*} task 
     */
    remove(task) {
      if (!this.queue[task]) {
        return false
      }
      this._size--
      this.queue[task]['timer'].stop()
      return delete this.queue[task]
    }

    /**
     * 向一个task任务队列中新增一个已发送的数据
     * @param {*} task 
     * @param {*} pos 
     * @param {*} data 
     */
    push(task, pos, data) {
      if (!this.queue[task]) {
        return false
      }
      let Q = this.queue[task]['Q']
      if (Q.size >= Q.cap) {
        return false
      }
      this.queue[task]['Q'].push(pos, data)
    }

    /**
     * 根据task获取该任务的所有信息
     * @param {*} task 
     */
    location(task) {
      return this.queue[task]
    }
  }
  return sendQueue;
}))
