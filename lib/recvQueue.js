/**
 * 1. 一段时间内UDP传输过程中的seq资源的分配、消费管理；
 * 2. 一段时间内UDP传输过程中的数据包状态管理
 *     - 数据包控制位的设置与解析
 *     - 数据包数据传输状态的管理
 */
import { DONED, BDD } from './kupack'
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
  const UPCD_SIZE = 100;  // 触发上报数据包的最小限制

  class RecvBuffer {
    constructor(cap, task, isn, notifyCb, ackCb, doneCb, ctx) {
      this._cap = cap    // 最大容量
      this._task = task
      this._isn = isn
      this._size = 0
      this._finished = doneCb
      this._notifyCb = notifyCb
      this._ackCb = ackCb
      this._ctx = ctx
      this.initOther();
    }

    get cap() { return this._cap }

    get size() { return this._size }

    initOther() {
      let { ip } = this._ctx.peerInfo
      this.PACK_SIZE = utils.IsLanIP(ip) ? WAN_PACK_SIZE : LAN_PACK_SIZE;
      this._stage = [];          // 乱序的数据包暂存
      this._next = 0;            // 当前连续的未被读取终止下标的下一个
      this._pos = this._isn - 1; // 当前连续的已被读取序号
      this._cmp = (a, b) => { return a.index - b.index; }
    }

    /**
     * 检测序号是否回绕，所有的序号均为无符号
     * @param {*} seq 
     */
    checkWrap(seq) {
      return seq < this._isn
    }

    /**
     * 检测当前序号是否已经有写入
     * TODO: 需要判断是否回绕
     * @param {*} seq 
     */
    checkDup(seq) {
      if (seq < this._pos && !this.checkWrap(seq)) {
        return true
      }
      return false
    }

    /**
     * 检测是否满足上报的逻辑
     *  - 缓冲区的数据包个数超过 UPCD_SIZE
     *  - 已经是最后一个数据包了 DONED BDD
     * @param {*} buf 
     * @param {*} mtype 
     */
    checkUpState(packcount, mtype) {
      if (packcount >= UPCD_SIZE) {
        return true
      }
      if (mtype == BDD || mtype == DONED) {
        typeof this._finished === 'function' && this._finished(this._task)
        return true
      }
      return false
    }

    // 检测乱序缓存，试图迁移到正序的 buffer, TODO: 是否可以更快检测
    checkStage(timeout) {
      let stage = []
      // 仅仅在真正接收到数据时，才有可能分配必要的内存空间
      if (!this._buf) {
        // 此处加1的目的是，让超过数据包的个数上报应用层比超过数据包大小的可能更大
        this._buf = Buffer.alloc((UPCD_SIZE << 4) * this.PACK_SIZE)
        this._packcount = 0
      }
      for (let j = 0, len = this._stage.length; j < len; j++) {
        let each = this._stage[j]
        let data = each.data
        let { payload, mtype } = data
        if (each.index == this._next) {
          this._next = (this._next + 1) % this._cap
          if (payload.length + this._buf._woffset < this._buf.length) {
            this._buf.writeBuffer(payload);
            this._pos = each.seq
            this._packcount++
            if (timeout || this.checkUpState(this._packcount, mtype)) {
              this.flush(data);
              this._packcount = 0
            }
          } else {
            // 溢出buf size，理论上不会出现该case
            console.error("checkStage over flow")
            if (this._buf.empty()) {
              this._buf.writeBuffer(payload);
              this.flush(data);
            } else {
              this.flush(data);
              this._buf.writeBuffer(payload);
            }
            this._pos = this._stage[j].seq
          }
        } else if (each.index > this._next) {
          if (timeout && this.checkUpState(this._packcount, mtype)) {
            console.log("checkStage _packcount", this._packcount)
            this.flush(data);
            this._packcount = 0
          }
          stage.push(each)
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
      if (this.checkDup(seq)) {
        // console.error("push RecvBuffer dup package", seq, data)
        return false
      }
      let index = this.index(seq)
      if (index < 0) {
        console.error("push pos", index, data)
      }
      // 安装pos从小到大排序写入到临时缓存中
      utils.pushAtSortPosition(this._stage, { index, seq, data }, this._cmp, true)
      this.checkStage()
      this._size++
      return true
    }

    index(seq) {
      return (seq - this._isn) % this._cap
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
        this.queue[task] = {}
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
        this.queue[task]['timer'] = taskTimer
        this.queue[task]['Q'] = new RecvBuffer(
          buffcap, task, isn, notifyCb, ackCb, this.done.bind(this), data); // 创建发送缓冲器
        this.queue[task]['Q'].push(isn, data)
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
      let status = this.queue[task]['Q'].push(seq, data)
      if (!status) {
        // console.error("push recvQueue failed", task, seq, data)
      }
      return status
    }

    done(task) {
      let ATask = this.queue[task]
      let ATaskTimer = ATask['timer']
      ATaskTimer.setArgs({ done: 1 })
    }

    timeout(task, ip, port, ctx) {
      console.log("timeout", task, ip, port, ctx)
      let ATask = this.queue[task]
      let ATaskQ = ATask['Q']
      let ATaskTimer = ATask['timer']
      if (ATaskQ) {
        ATaskQ.checkStage(true)
      }
      if (1 == (ATaskTimer.args || {}).done) {
        this.remove(task)
      } else {
        ATaskTimer.restart(ACK_ECHO_TIMEOUT)
      }
    }
  }
  return recvQueue;
}))
