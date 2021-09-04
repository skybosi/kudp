### `open(address[, port][, flag])` 创建kudp连接
- address: {string} 要创建连接的 `IP` 地址
- port: {int} 要创建连接的 `port` 地址, 默认5328
- flag: {int} 连接模式参数, 可选值如下
  - 0: 不生成连接id, 用于稳定局域网
  - 1: 生成1字节的cid, 用于小型局域网
  - 2: 生成4字节的cid, 用于大型局域网
  - 3: 生成8字节的cid, 用于广域网
- 返回: {int} `连接文件描述符`

### `close(fd)` 关闭kudp连接
- fd: {int} 由`open`创建出来的文件描述符
- 返回: 空

### `create(fd[, flag])` 在一个kudp连接创建一个发送通道task
- fd: {int} 由`open`创建出来的文件描述符
- flag: 
- 返回: tn {int} 隐式创建的 tn, 表示当前唯一 `task number`

### `send(tn, buf, len[, flag])` 向一个kudp连接发送数据包
- tn: {int} 由`create`创建出来的`task number`
- buf: {string} | {Buffer} | {ArrayBuffer} 待发送的数据
- len: {int} 待发送的数据长度, 单位字节
- flag: 
- 返回: size {int} 发送成功的字节数 -1表示异常

### `recv(tn, buf, len[, flag])` 从一个kudp连接接收数据包, 回调的方式
- tn: {int} 由`create`创建出来的`task number`
- buf: {Buffer} 接收到的数据
- len: {int} 接收到的数据, 单位字节
- flag: 
- 返回: size {int} 成功接收的字节数 -1表示异常

### `error(fd, tn, code, msg)` 从一个kudp连接返回异常信息, 回调的方式
- fd: {int} 由`open`创建出来的文件描述符
- tn: {int} 由`create`创建出来的`task number`, `0` 表示连接级别
- code: {int} 异常错误码
- msg: {string} 异常信息
- 返回: tn {int} 隐式创建的 tn, 表示当前唯一 `task number`

### `reset(fd[, tn][, flag])` 重置一个的发送任务
- fd: {int} 由`open`创建出来的文件描述符
- tn: {int} 由`create`创建出来的`task number`
- flag: {int}
  - 0: 表示暂停该task的数据传输
  - 1: 表示终止该task的数据传输
  - 2: 表示撤回该task的已经传输的数据
- 返回: status \<bool> 状态

### `broadcast([option])` 局域网内，广播消息
- option: {Object} 一些需要广播附带的信息，用于搭建组网的基本信息
- 返回: 空

