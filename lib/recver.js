/**
 * 接收器：
 * 接收到数据包后，做上报业务层管理器
 * 在一次单向的发送 <--> 接收 的过程中
 *  发送方：仅仅只会接收  ABROAD ~ ABDD
 *  接收方：仅仅只会接收  BROAD ~ BDD
 * 对于接收器来说，只会处理接收到的数据包，并对接收到的数据包做一些相应的处理
 *
 * 概念:
 * - 数据块级别：表示一次独立的完整传输过程，比如一张图片，一段文本，一个视频，由被分离的数据包组装而成，必须包含 BEGIN -> DOING -> DONED / BDD 的数据包类型
 * - 接收器级别：一个完整的接收器等级，接收器可以同时接受多个不同的独立数据块传输（数据块级别），比如一段文字、一张图片 可以同时传输
 *
 * 关键成员功能作用:
 * - staging: 接收器级别，用来记录所有没有收到 BEGIN 数据包的数据包，暂存起来等待首个数据包，TODO：是一个恶意攻击点
 * - queues: 接收器级别，管理所有的数据块的接收队列

 * 公开的kudp层回调接口:
 * - onUp:   数据块级别，用来数据包接收器处理已经就绪的数据包时的上报回调，TODO：怎么分离出不同的数据块
 * - onEcho: 数据块级别，在接收到数据包后，需要做出的响应动作，比如向发送发恢复ACK，TODO：同上
 * - onTick: 数据块级别，在接收到数据包时的回调，主要用来方便统计，TODO：同上
 * - onAck:  数据块级别，在接收到ACK类型的数据包时的回调，TODO：同上
 * - onDone: 数据块级别，数据包接收完成回调，TODO：同上
 * - onErrs: 数据块级别，数据包接收过程异常时回调，TODO：怎么判断异常？
 */
import { PROTONAME, VERSION, SEP } from './constant';
import { BROAD, MULTI, BEGIN, DOING, DONED, BDD, ABROAD } from './kupack'

(function (root, factory) {
  'use strict'
  if (typeof define === 'function' && define.amd) define([], factory)
  else if (typeof exports === 'object') module.exports = factory()
  else root.Recver = factory()
}(this, function () {
  const kupack = require('./kupack').Package
  const Queue = require('./recvQueue')

  const utils = require('./common/utils')
  const Stat = require('./common/Stat.js')

  const FACTOR = 4     // 默认放大因子
  const BASE_SECTION = 256 // 基础段长度
  const KUDP_RCVBUF_SIZE = FACTOR * BASE_SECTION // 4194304 // 4 * 1024 * 1024 byte

  /**
   * 接收器，每一个时刻需要处理多个来源的数据，所以需要处理和应对多个接收队列以及背后的接收缓冲区
   */
  const R_PREFIX = [PROTONAME, VERSION, 'recver'].join(SEP)
  class Recver {

    constructor(options) {
      this.staging = {};
      this.stage_size = 0;
      this.stat = new Stat();
      for (var prop in this.defaultOptions) this[prop] = this.defaultOptions[prop]
      this.queues = {}
      this.initOptions(options);
    }

    defaultOptions = {
      onUp: () => { },    // 上报上层回调
      onEcho: () => { },  // 接收到消息后，回复ack
      onAck: () => { },   // 接收到Ack类型数据包回调
      onDone: () => { },  // 数据包接收完成回调
      onErrs: () => { },  // 数据包接收异常回调
      onTick: () => { },  // 在接收到数据包时的回调，可用于统计
    }

    // 初始化cb options
    initOptions(option, value) {
      if (option && value) this[option] = value
      if (!value && typeof option === 'object') {
        for (var prop in option) {
          if (this.defaultOptions.hasOwnProperty(prop) && this.hasOwnProperty(prop))
            this[prop] = option[prop]
        }
      }
      return this
    }

    /********************** 外部函数 **********************/

    // 接收到数据
    recv(res) {
      let { mtype, task_seq, task, seq, payload, version } = this.decode(res.message)
      let remoteInfo = res.remoteInfo
      let ip = remoteInfo.address, port = remoteInfo.port
      let ipint = utils.Ip2Int(remoteInfo.address); // ip对应的数字
      let peerInfo = { ip, port, ipint }
      console.info("recv data type task peer", mtype, task, seq, task_seq)
      // 根据接收到的数据初始化一个接收任务队列，如果已经存在将复用
      let meta = { name: [R_PREFIX, ip, port, task].join(SEP), seq, version }
      let RqID = this.initQueue(ip, port, task, meta);
      // 接收到不同数据包的处理
      if (mtype < ABROAD) {
        this.recvData(RqID, mtype, task_seq, task, seq, peerInfo, payload, version);
      } else {
        this.recvAck(RqID, mtype, task_seq, task, seq, peerInfo, payload, version);
      }
      // this.onTick(RqID, mtype, 0);
    }

    /********************** 内部函数 **********************/

    /**
     * 接收方：处理来自网络的数据包 推送一个接收到的数据到接收队列，
     * @param {*} RqID 
     * @param {*} mtype 
     * @param {*} task_seq 
     * @param {*} task 
     * @param {*} seq 
     * @param {*} peerInfo 
     * @param {*} payload 
     * @param {*} version 
     */
    recvData(RqID, mtype, task_seq, task, seq, peerInfo, payload, version) {
      switch (mtype) {
        case DOING:
          this.addStage(RqID, mtype, task_seq, task, seq, peerInfo, payload, version);
          break;
        case DONED:
          this.addStage(RqID, mtype, task_seq, task, seq, peerInfo, payload, version);
          break;
        case BEGIN:
          this.begin(RqID, mtype, task_seq, task, seq, peerInfo, payload, version);
          break;
        case BDD:
          this.bdd(RqID, mtype, task_seq, task, seq, peerInfo, payload, version);
          break;
        case BROAD:
          this.notify(peerInfo.ip, peerInfo.port, mtype, RqID, seq, payload, { task, version });
          break;
        case MULTI:
          this.notify(peerInfo.ip, peerInfo.port, mtype, RqID, seq, payload, { task, version });
          break;
        default:
          this.onErrs("invalid type", RqID, mtype, task_seq, task, seq, peerInfo, payload, version, this);
          break;
      }
    }

    /**
     * 发送方：处理来自网络的确认包 接收到ack数据包处理
     * @param {*} RqID 
     * @param {*} mtype 
     * @param {*} task_seq 
     * @param {*} task 
     * @param {*} seq 
     * @param {*} peerInfo 
     * @param {*} payload 
     * @param {*} version 
     */
    recvAck(RqID, mtype, task_seq, task, seq, peerInfo, payload, version) {
      this.onAck(mtype, task_seq, peerInfo, payload)
    }

    /**
     * 处理 BEGIN 数据包时，需要检测是否存在预先到达的本数据块的 DOING / DONED 包
     * @param {*} RqID 
     * @param {*} mtype 
     * @param {*} task_seq 
     * @param {*} task 
     * @param {*} seq 
     * @param {*} peerInfo 
     * @param {*} payload 
     * @param {*} version 
     */
    begin(RqID, mtype, task_seq, task, seq, peerInfo, payload, version) {
      this.insert(RqID, mtype, task_seq, task, seq, peerInfo, payload, version);
      this.checkStage(RqID, mtype, task_seq, task, seq, peerInfo, payload, version)
    }

    /**
     * 处理 BDD 数据，直接上报
     * @param {*} RqID 
     * @param {*} mtype 
     * @param {*} task_seq 
     * @param {*} task 
     * @param {*} seq 
     * @param {*} peerInfo 
     * @param {*} payload 
     * @param {*} version 
     */
    bdd(RqID, mtype, task_seq, task, seq, peerInfo, payload, version) {
      this.insert(RqID, mtype, task_seq, task, seq, peerInfo, payload, version)
    }

    /**
     * 检测接收缓冲区是否已经满或者数据发送完毕
     * @param {*} ip 
     * @param {*} port 
     * @param {*} mtype 
     * @param {*} payload 
     * @param {*} task_seq 
     */
    notify(ip, port, mtype, RqID, seq, payload, ctx) {
      this.onUp(ip, port, mtype, RqID, seq, payload, ctx);
    }

    /**
     * 暂存区处理
     * 1. 提前到达的DOING/DONED 暂存
     * 2. 重复到达的DOING/DONED 丢弃
     * TODO：内存问题
     * @param {*} RqID 
     * @param {*} mtype 
     * @param {*} task_seq 
     * @param {*} task 
     * @param {*} seq 
     * @param {*} peerInfo 
     * @param {*} payload 
     * @param {*} version 
     */
    addStage(RqID, mtype, task_seq, task, seq, peerInfo, payload, version) {
      let curnode = this.location(RqID);
      if (curnode) {
        // 内部处理重复，回绕，判断是否接收完毕
        this.push(RqID, mtype, task_seq, task, seq, peerInfo, payload, version)
      } else {
        // 未找到BEGIN的数据包, 为了避免恶意攻击，限制最大缓存max_stage个无 BEGIN 数据包
        if (this.stage_size++ <= KUDP_RCVBUF_SIZE) {
          this.staging[RqID] = { RqID, mtype, task_seq, task, seq, peerInfo, payload, version };
        }
      }
    }

    /**
     * 检测所有暂存区中已有的seq
     * @param {*} RqID 
     * @param {*} mtype 
     * @param {*} task_seq 
     * @param {*} task 
     * @param {*} seq 
     * @param {*} peerInfo 
     * @param {*} payload 
     * @param {*} version 
     */
    checkStage(RqID, mtype, task_seq, task, seq, peerInfo, payload, version) {
      for (var aRqID in this.staging) {
        let stage = this.staging[aRqID]
        let stg_seq = stage.seq,
          stg_task = stage.task,
          stg_mtype = stage.mtype,
          stg_peer = stage.peerInfo,
          stg_payload = stage.payload,
          stg_version = stage.version,
          stg_task_seq = stage.task_seq
        if (checkMatchPeer(stg_peer, peerInfo)) {
          this.push(RqID, stg_mtype, stg_task_seq, stg_task, stg_seq, stg_peer, stg_payload, stg_version)
          this.stage_size--;
          delete this.staging[stg_seq];
        }
      }
    }

    /**
     * 释放接收队列中的已经确认的seq
     * @param {*} node 
     */
    ack(ip, port, mtype, lastask_seq, ctx) {
      // console.info("onEcho isn, seq, max:", ip, port, lastask_seq, ctx);
      this.onEcho(ip, port, mtype, lastask_seq, +new Date);
    }

    /**
     * 并发传输多个数据块的处理队列，新建一个接收队列，如果有必要的实话
     * @param {*} ip 
     * @param {*} port 
     * @param {*} task 
     * @param {*} meta 
     */
    initQueue(ip, port, task, meta) {
      let RqID = [ip, port, task].join(SEP)
      if (!this.queues[RqID]) {
        this.queues[RqID] = new Queue(ip, port, meta);
      }
      return RqID
    }

    /**
     * 将数据写入接收对应的接收队列，满足条件后上报业务层
     * @param {*} RqID 
     * @param {*} mtype 
     * @param {*} task_seq 
     * @param {*} task 
     * @param {*} seq 
     * @param {*} peerInfo 
     * @param {*} payload 
     * @param {*} version 
     */
    insert(RqID, mtype, task_seq, task, seq, peerInfo, payload, version) {
      let cap = (mtype === BEGIN) ? KUDP_RCVBUF_SIZE : 1;
      let isn = (mtype === BEGIN || mtype === BDD) ? seq : null
      let data = { RqID, mtype, task_seq, task, isn, peerInfo, payload, version, stime: +new Date }
      this.queues[RqID].insert(task, cap, data, this.notify.bind(this), this.ack.bind(this));
    }

    /**
     * 将一个数据包写入到接收队列中
     * @param {*} RqID 
     * @param {*} mtype 
     * @param {*} task_seq 
     * @param {*} task 
     * @param {*} seq 
     * @param {*} peerInfo 
     * @param {*} payload 
     * @param {*} version 
     */
    push(RqID, mtype, task_seq, task, seq, peerInfo, payload, version) {
      let data = { RqID, mtype, task_seq, task, seq, peerInfo, payload, version, seq, stime: +new Date }
      this.queues[RqID].push(task, seq, data)
    }

    /**
     * 定位一个seq 在 queue中的在 BEGIN 时创建的元数据信息，若不存在返回 null
     * @param {*} RqID 
     */
    location(RqID) {
      return this.queues[RqID]
    }

    /**
     * 检测两次链接是否为同一个链接
     * 必须是同一个ip:port 或 连接迁移 TODO
     * @param {*} buffer 
     */
    checkMatchPeer(peer1, peer2) {
      return peer1.address === peer2.address && peer1.port === peer2.port
    }

    /**
     * 解析从外界收到的数据包
     * @param {*} buffer 
     */
    decode(buffer) {
      let { header, task_seq, task, seq, version, payload } = kupack.unpack(buffer);
      let mtype = header.Type();
      return { mtype, version, task_seq, task, seq, payload }
    }
  }

  return Recver;
}))
