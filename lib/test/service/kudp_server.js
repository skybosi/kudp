const kudp = require('../../kudp')
const WriteStream = require('../../common/stream/stream').WriteStream

var kudp0 = new kudp(5328);

var outfile = new WriteStream("../tmp/1_new.txt", {
    flags: 'w+',
    mode: 0o666,
    encoding: 'utf8',
    autoClose: false,
    start: 0,
})

var total = 0
kudp0.recv((fdtn, buf, len) => {
    var flag = outfile.write(buf)
    if (total == 0) {
        console.log("---------------------------------------------------------------------------")
    }
    total += len
    console.log("recv", buf, total)
})
