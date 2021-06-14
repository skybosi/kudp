/**
 * 1. 一段时间内UDP传输过程中的seq资源的分配、消费管理；
 * 2. 一段时间内UDP传输过程中的数据包状态管理
 *     - 数据包控制位的设置与解析
 *     - 数据包数据传输状态的管理
 */
import { BDD } from './kupack'
import { Errors, ENOTALLOCISN, } from './errors';
import { LAN_PACK_SIZE, WAN_PACK_SIZE } from './constant';

(function (root, factory) {
  'use strict'
  if (typeof define === 'function' && define.amd) define([], factory)
  else if (typeof exports === 'object') module.exports = factory()
  else root.recvQueue = factory()
}(this, function () {
  const timer = require('./common/timer')
  const Buffer = require('./common/Buffer/Buffer')

  const utils = require('./common/utils')

  const ACK_ECHO_TIMEOUT = 200
  const UPCD_SIZE = 5;  // 触发上报数据包的最小限制

  class RecvBuffer {

    constructor(cap, task, isn, notifyCb, ackCb, ctx) {
      this._cap = cap    // 最大容量
      this._task = task
      this._isn = isn
      this._size = 0
      this._notifyCb = notifyCb
      this._ackCb = ackCb
      this._ctx = ctx
      this.init();
    }

    get cap() { return this._cap }

    get size() { return this._size }

    init() {
      let { ip } = this._ctx.peerInfo
      let PACK_SIZE = utils.IsLanIP(ip) ? WAN_PACK_SIZE : LAN_PACK_SIZE;
      this._buf = Buffer.alloc(this._cap * PACK_SIZE)
      this._buffer = [];  // 接收数据数组
      this._stage = [];   // 乱序的序号下标
      this._begin = 0;    // 当前连续的未被读取起始下标
      this._end = 0;      // 当前连续的未被读取终止下标的下一个
      this._cmp = (a, b) => { return a.pos - b.pos; }
    }

    /**
     * 检测当前序号是否已经有写入
     * TODO: 需要判断是否回绕
     * @param {*} seq 
     */
    checkPos(seq) {
      let pos = seq - this._isn
      if (pos >= this._begin && pos < this._end) {
        return true
      }
      return false
    }

    // 检测乱序缓存，试图迁移到正序的 _buffer, TODO: 是否可以更快检测
    checkStage() {
      let stage = []
      let offset = this._buf._woffset, max = this._buf.length;
      let wbufsize = 0
      for (let j = this._begin, len = this._stage.length; j < len; j++) {
        if (this._stage[j].pos == this._end) {
          this._end++
          let data = this._stage[j].data
          let { payload, mtype } = data
          let size = payload.length
          if (size + offset < max) {
            this._buf.writeBuffer(payload);
            this._begin++
            wbufsize++
            if (wbufsize >= UPCD_SIZE || mtype == BDD) {
              this.flush(data);
            }
          } else { //  len + offset >= max
            if (this._buf.empty()) {
              this._buf.writeBuffer(payload);
              this.flush(data);
            } else {
              this.flush(data);
              this._buf.writeBuffer(payload);
            }
          }
        } else {
          stage.push(this._stage[j])
        }
      }
      this._stage = stage
    }

    /**
     * 如果有数据，手动刷出接收缓冲区中的数据，建议在确认接收数据结束时，刷出剩余的数据
     */
    flush(data) {
      if (typeof this._ackCb === 'function') {
        let { task_seq, mtype } = data
        let { ip, port } = this._ctx.peerInfo
        this._ackCb(ip, port, mtype, task_seq, data) // 回调ack
      }
      if (typeof this._notifyCb === 'function') {
        if (0 !== this._buf._woffset) {
          let { mtype, RqID, task_seq } = data
          let { ip, port } = this._ctx.peerInfo
          // 回调上报数据通
          let buff = this._buf.readBuffer(0, this._buf._woffset)
          this._notifyCb(ip, port, mtype, RqID, task_seq, buff, data)
          this._buf.flush()
        }
      }
    }

    /**
     * 向接收缓冲区推入新的接收到的数据
     * @param {*} seq 
     * @param {*} data 
     */
    push(seq, data) {
      if (this.checkPos(seq)) {
        console.error("push RecvBuffer dup package", seq, data)
        return
      }
      let pos = seq - this._isn
      /**
       * 将当前pos 放入乱序的首位，如果pos 正好是this._eoff期待的这个下标，将优先处理，
       * 之后的循环过程顺便处理曾经先到达的乱序下标(说明存在空洞，即说明有先到的数据包)
       */
      utils.pushAtSortPosition(this._stage, { pos, data }, this._cmp, true)
      this.checkStage()
      this._size++
    }
  }

  class recvQueue {
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

    insert(task, buffcap, data, notifyCb, ackCb) {
      if (this._size >= this._cap) {
        return null
      }
      let isn = data.isn
      let queue_task = this.queue[task] || {}
      let taskTimer = queue_task['timer']
      if (!taskTimer) {
        taskTimer = new timer({
          onend: (args) => {
            let { task, ip, port, ctx } = args
            this.timeout(task, ip, port, ctx)
          },
          onstop: (args) => {
            console.info("timeout", args)
          }
        }, { task, ip: data.peerInfo.ip, port: data.peerInfo.port, ctx: data });
        taskTimer.setArgs({ done: 0, timeout: 0 });
        this.queue[task] = {}
        this.queue[task]['Q'] = new RecvBuffer(buffcap, task, isn, notifyCb, ackCb, data); // 创建发送缓冲器
        this.queue[task]['Q'].push(isn, data)
        this.queue[task]['timer'] = taskTimer
        this._size++
        taskTimer.start(ACK_ECHO_TIMEOUT)
      } else {
        console.error("insert recvQueue dup package", task, data)
      }
      return this.queue[task]
    }

    remove(task) {
      if (!this.queue[task]) {
        return false
      }
      this._size--
      this.queue[task]['timer'].stop()
      return delete this.queue[task]
    }

    push(task, seq, data) {
      if (!this.queue[task]) {
        return false
      }
      let Q = this.queue[task]['Q']
      if (Q.size >= Q.cap) {
        return false
      }
      if (Q.checkPos(seq)) {
        console.error("push recvQueue dup package", task, pos, data)
        return
      }
      this.queue[task]['Q'].push(seq, data)
    }

    timeout(task, ip, port, ctx) {
      console.log("timeout", task, ip, port, ctx)
      let ATask = this.queue[task]
      let ATaskQ = ATask['Q']
      let ATaskTimer = ATask['timer']
      if (ATaskQ) {
        ATaskQ.checkStage()
      }
      this.remove(task)
      // if (1 == (ATaskTimer.args || {}).done) {
      //   this.remove(task)
      // } else {
      //   ATaskTimer.restart(ACK_ECHO_TIMEOUT)
      // }
    }
  }
  return recvQueue;
}))
