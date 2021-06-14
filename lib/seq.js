/**
 * 1. 一段时间内UDP传输过程中的seq资源的分配、消费管理；
 * 2. 一段时间内UDP传输过程中的数据包状态管理
 *     - 数据包控制位的设置与解析
 *     - 数据包数据传输状态的管理
 */
import { Errors, ENOTALLOCISN, } from './errors';
import { SECTION, } from './constant';

(function (root, factory) {
  'use strict'
  if (typeof define === 'function' && define.amd) define([], factory)
  else if (typeof exports === 'object') module.exports = factory()
  else root.SeqManage = factory()
}(this, function () {
  const utils = require('./common/utils')

  const RIGHT_MOVE = 11
  const ISN_INTERVAL = 1 << RIGHT_MOVE  // 2048
  const MAX_SEQ = ((~(0)) >>> 0) + 1
  const MAX_SEQ_NUM = ((-1 >>> 8) + 1) >>> 0
  const MAX_TASK_NUM = 0xff >>> 0

  class SeqManage {
    constructor() {
      this.seqs = { '-1': { size: 0, wrap: 0 } }
    }
    get size() {
      return this.seqs["-1"]['size']
    }
    get wrap() {
      return this.seqs["-1"]['wrap']
    }
    /**
     * @param {number} size
     * @returns {number} task  一个新的数据包发送，申请一个新的isn
     */
    malloc() {
      return this.getTaskNum()
    }

    /**
     * 获取一个可用的任务号, 并随机生成一个isn
     */
    getTaskNum() {
      let i = 0
      for (const seq in this.seqs) {
        if (Number(seq) != i && i <= MAX_TASK_NUM) {
          let task = i >>> 0
          let seq = utils.RandomNum(0, MAX_SEQ_NUM) >>> 0
          this.seqs[i] = { isn: seq, cursor: seq, wrap: 0, task: task }
          this.seqs["-1"]['size']++
          return SeqManage.encode(task, seq)
        }
        i++;
      }
      throw Errors(ENOTALLOCISN, "no match task");
    }

    /**
     * @param {number} task a task
     * 数据包确认完后，即时释放和清除
     */
    free(task) {
      if (!this.seqs[task]) {
        return false
      }
      return delete this.seqs[task]
    }

    /**
     * 获取下一个可用的seq
     * @param {number} task will return a seq from a task
     * @param {boolean} loop true loop use seq number, false not loop
     * @returns {boolean} seq a next seq can be use 
     */
    next(task_seq) {
      let task_info = this.location(task_seq)
      if (!task_info || !this.seqs[task_info['task']]) {
        throw Errors(ENOTALLOCISN, "no match task");
      }
      let task = task_info['task']
      let seq = this.seqs[task]['cursor']
      let wrap = (seq + 1 >= MAX_SEQ_NUM) // seq 回绕
      if (wrap) {
        this.seqs['-1']['wrap']++
        this.seqs[task]['wrap']++
        this.seqs[task]['cursor'] = 0
      } else {
        this.seqs[task]['cursor']++
      }
      return SeqManage.encode(task, seq)
    }

    /**
     * @param {number} seq a seq number
     * @returns {object} 获取定位一个seq属于哪个isn段内
     */
    location(task_seq) {
      let { task, seq } = SeqManage.decode(task_seq)
      if (!this.seqs[task]) {
        throw Errors(ENOTALLOCISN, "no match task");
      }
      return { task, seq, task_info: this.info(task) }
    }

    /**
     * @param {number} task
     * @returns {object} 获取isn对应的所有信息
     */
    info(task) {
      return this.seqs[task];
    }

    /**
     * 清空并释放所有
     */
    clear() {
      this.seqs = { '-1': { size: 0, wrap: 0 } }
    }

    static decode(task_seq) {
      if (seq < 0 || seq > MAX_SEQ) {
        return null
      }
      let task = (task_seq & (0xff << 24)) >>> 24
      let seq = (task_seq & (~(0xff << 24))) >>> 0
      return { task, seq }
    }

    static encode(task, seq) {
      if (task < 0 || task > MAX_SEQ_NUM) {
        return null
      }
      if (seq < 0 || seq > MAX_SEQ_NUM) {
        return null
      }
      let task_seq = 0
      task_seq |= (task << 24)
      task_seq |= seq
      task_seq = task_seq >>> 0
      return task_seq
    }

    /**
     * 测试函数
     */
    static testSeqManage() {
      let seqm = new SeqManage();
      var i = 0;
      // test max task exception
      while (i < 256) {
        if (seqm.wrap > 0) {
          console.log(task, seqm)
        }
        try {
          let task = seqm.malloc();
          console.log(task, seqm)
        } catch (error) {
          break;
        }
        i++
      }
      // test clear SeqManage
      seqm.clear();
      // test wrap SeqManage
      let task_seq = seqm.malloc()
      while (true) {
        let task_seq_each = seqm.get(task_seq)
        if (seqm.location(task_seq_each)['cursor'] + 10 > MAX_SEQ_NUM) {
          console.log("will wrap:", task_seq, task_seq_each, seqm)
        }
        if (seqm.location(task_seq_each)['wrap'] > 0) {
          console.log("seq wrap:", task_seq, task_seq_each, seqm)
          let task_seq_each = seqm.get(task_seq)
          console.log("seq wraped:", task_seq, task_seq_each, seqm)
          break;
        }
      }
      // test decode
      console.log(SeqManage.decode(0x00000000))   // 0x00-0x000000
      console.log(SeqManage.decode(0x01000000))   // 0x01-0x000000
      console.log(SeqManage.decode(0x00ffffff))   // 0x00-0xffffff
      console.log(SeqManage.decode(0x01ffffff))   // 0x01-0xffffff
      console.log(SeqManage.decode(0xff000000))   // 0xff-0x000000
      console.log(SeqManage.decode(0xfe000000))   // 0xfe-0x000000
      console.log(SeqManage.decode(0xffffffff))   // 0xff-0xffffff
      console.log(SeqManage.decode(0xfeffffff))   // 0xfe-0xffffff
      // test encode
      console.log(SeqManage.encode(0x00, 0x000000))   // 0x00-0x000000
      console.log(SeqManage.encode(0x01, 0xffffff))   // 0x01-0xffffff
      console.log(SeqManage.encode(0x12, 0xf34ff3))   // 0x12-0xf34ff3
      console.log(SeqManage.encode(0x00, 0xfedfff))   // 0x00-0xfedfff
      console.log(SeqManage.encode(0x21, 0xff23ff))   // 0x21-0xff23ff
      console.log(SeqManage.encode(0xf2, 0x000000))   // 0xf2-0x000000
      console.log(SeqManage.encode(0xfe, 0x002300))   // 0xfe-0x002300
      console.log(SeqManage.encode(0xf5, 0xffe4ff))   // 0xf5-0xffe4ff
      console.log(SeqManage.encode(0xfe, 0xffffff))   // 0xfe-0xffffff
    }
  }
  return SeqManage;
}))
