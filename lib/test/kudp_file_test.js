const kudp = require('../kudp')
const ReadStream = require('../common/stream/stream').ReadStream
const WriteStream = require('../common/stream/stream').WriteStream

const BPORT = 5328

var kudp0 = new kudp(BPORT);
let s3 = kudp0.open("127.0.0.1", BPORT, 3)
var fdtn = kudp0.create(s3, 0)
// kudp0.broadcast()

var out = new WriteStream("./kudp2.txt", {
    flags: 'w+',
    mode: 0o666,
    encoding: 'utf8',
    autoClose: true,
    start: 0,
})

var total = 0
kudp0.recv((fdtn, buf, len) => {
    out.write(buf)
    total += len
    console.log(buf)
    console.log(total)
})

var file = new ReadStream("D:\\myroom\\weixin\\duiyan\\libs\\kudp\\lib\\doc\\kudp2.md")
file.on("data", (buf) => {
    // console.log(buf.toString())
    kudp0.send(fdtn, buf, buf.length)
})
