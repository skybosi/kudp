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

  const MAX_TASK_SEQ = ((~(0)) >>> 0) + 1                 // task_seq最大值
  const SEQ_BYTE_COUNT = 32                               // 4byte的task_seq号
  const TASK_BIT_COUNT = 8                                // task号占的bit位
  const MAX_TASK_NUM = 1 << TASK_BIT_COUNT                // task号最大值
  const SEQ_BIT_COUNT = SEQ_BYTE_COUNT - TASK_BIT_COUNT   // seq号占的bit位
  const MAX_SEQ_NUM = ((-1 >>> TASK_BIT_COUNT) + 1) >>> 0 // seq号最大值

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
     * @returns {number} tn  一个新的数据包发送，申请一个新的isn
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
        if (Number(seq) != i && i < MAX_TASK_NUM) {
          let tn = i >>> 0
          let seq = utils.RandomNum(0, MAX_SEQ_NUM) >>> 0
          this.seqs[i] = { isn: seq, cursor: seq, wrap: 0, tn: tn }
          this.seqs["-1"]['size']++
          return SeqManage.encode(tn, seq)
        }
        i++;
      }
      throw Errors(ENOTALLOCISN, "no match tn");
    }

    /**
     * @param {number} tn a tn
     * 数据包确认完后，即时释放和清除
     */
    free(tn) {
      if (!this.seqs[tn]) {
        return false
      }
      return delete this.seqs[tn]
    }

    /**
     * 获取下一个可用的seq
     * @param {number} tn will return a seq from a tn
     * @param {boolean} loop true loop use seq number, false not loop
     * @returns {boolean} seq a next seq can be use 
     */
    next(task_seq) {
      let { task_info } = this.location(task_seq)
      if (!task_info || !this.seqs[task_info['tn']]) {
        throw Errors(ENOTALLOCISN, "no match tn");
      }
      let tn = task_info['tn']
      let seq = this.seqs[tn]['cursor']
      let wrap = (seq + 1 >= MAX_SEQ_NUM) // seq 回绕
      if (wrap) {
        this.seqs['-1']['wrap']++
        this.seqs[tn]['wrap']++
        this.seqs[tn]['cursor'] = 0
      } else {
        this.seqs[tn]['cursor']++
      }
      return SeqManage.encode(tn, seq)
    }

    /**
     * @param {number} seq a seq number
     * @returns {object} 获取定位一个seq属于哪个isn段内
     */
    location(task_seq) {
      let { tn, seq } = SeqManage.decode(task_seq)
      if (!this.seqs[tn]) {
        throw Errors(ENOTALLOCISN, "no match tn");
      }
      return { tn, seq, task_info: this.info(tn) }
    }

    /**
     * @param {number} tn
     * @returns {object} 获取isn对应的所有信息
     */
    info(tn) {
      return this.seqs[tn];
    }

    /**
     * 清空并释放所有
     */
    clear() {
      this.seqs = { '-1': { size: 0, wrap: 0 } }
    }

    static decode(task_seq) {
      if (task_seq < 0 || task_seq >= MAX_TASK_SEQ) {
        return null
      }
      let tn = (task_seq & (0xff << SEQ_BIT_COUNT)) >>> SEQ_BIT_COUNT
      let seq = (task_seq & (~(0xff << SEQ_BIT_COUNT))) >>> 0
      return { tn, seq }
    }

    static encode(tn, seq) {
      if (tn < 0 || tn >= MAX_TASK_NUM) {
        return null
      }
      if (seq < 0 || seq >= MAX_SEQ_NUM) {
        return null
      }
      let task_seq = 0
      task_seq |= (tn << SEQ_BIT_COUNT)
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
      // test max tn exception
      while (i < MAX_TASK_NUM) {
        if (seqm.wrap > 0) {
          console.log(tn, seqm)
        }
        try {
          let tn = seqm.malloc();
          console.log(tn, seqm)
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
        let task_seq_each = seqm.next(task_seq)
        if (seqm.location(task_seq_each)['task_info']['cursor'] + 10 >= MAX_SEQ_NUM) {
          console.log("will wrap:", task_seq, task_seq_each, seqm)
        }
        let { task_info } = seqm.location(task_seq_each)
        if (task_info['wrap'] > 0) {
          console.log("seq wrap:", task_seq, task_seq_each, seqm)
          let task_seq_each = seqm.next(task_seq)
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
