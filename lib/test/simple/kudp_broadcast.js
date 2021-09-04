const kudp = require('../../kudp')
const BPORT = 5328

var kudp0 = new kudp(BPORT);
kudp0.broadcast()

kudp0.recv((fdtn, buf, len) => {
    console.log(buf)
})