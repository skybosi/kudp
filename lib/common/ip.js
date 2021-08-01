'use strict';

var ip = exports;

ip.toString = function (buff, offset, length) {
    offset = ~~offset;
    length = length || (buff.length - offset);

    var result = [];
    if (length === 4) {
        // IPv4
        for (var i = 0; i < length; i++) {
            result.push(buff[offset + i]);
        }
        result = result.join('.');
    } else if (length === 16) {
        // IPv6
        for (var i = 0; i < length; i += 2) {
            result.push(buff.readUInt16BE(offset + i).toString(16));
        }
        result = result.join(':');
        result = result.replace(/(^|:)0(:0)*:0(:|$)/, '$1::$3');
        result = result.replace(/:{3,4}/, '::');
    }

    return result;
};

var ipv4Regex = /^(\d{1,3}\.){3,3}\d{1,3}$/;
var ipv6Regex =
    /^(::)?(((\d{1,3}\.){3}(\d{1,3}){1})?([0-9a-f]){0,4}:{0,2}){1,8}(::)?$/i;

ip.isV4Format = function (ip) {
    return ipv4Regex.test(ip);
};

ip.isV6Format = function (ip) {
    return ipv6Regex.test(ip);
};
function _normalizeFamily(family) {
    return family ? family.toLowerCase() : 'ipv4';
}

ip.cidr = function (cidrString) {
    var cidrParts = cidrString.split('/');

    var addr = cidrParts[0];
    if (cidrParts.length !== 2)
        throw new Error('invalid CIDR subnet: ' + addr);

    var mask = ip.fromPrefixLen(parseInt(cidrParts[1], 10));

    return ip.mask(addr, mask);
};

ip.subnet = function (addr, mask) {
    var networkAddress = ip.toLong(ip.mask(addr, mask));

    // Calculate the mask's length.
    var maskBuffer = ip.toBuffer(mask);
    var maskLength = 0;

    for (var i = 0; i < maskBuffer.length; i++) {
        if (maskBuffer[i] === 0xff) {
            maskLength += 8;
        } else {
            var octet = maskBuffer[i] & 0xff;
            while (octet) {
                octet = (octet << 1) & 0xff;
                maskLength++;
            }
        }
    }

    var numberOfAddresses = Math.pow(2, 32 - maskLength);

    return {
        networkAddress: ip.fromLong(networkAddress),
        firstAddress: numberOfAddresses <= 2 ?
            ip.fromLong(networkAddress) :
            ip.fromLong(networkAddress + 1),
        lastAddress: numberOfAddresses <= 2 ?
            ip.fromLong(networkAddress + numberOfAddresses - 1) :
            ip.fromLong(networkAddress + numberOfAddresses - 2),
        broadcastAddress: ip.fromLong(networkAddress + numberOfAddresses - 1),
        subnetMask: mask,
        subnetMaskLength: maskLength,
        numHosts: numberOfAddresses <= 2 ?
            numberOfAddresses : numberOfAddresses - 2,
        length: numberOfAddresses,
        contains: function (other) {
            return networkAddress === ip.toLong(ip.mask(other, mask));
        }
    };
};

ip.cidrSubnet = function (cidrString) {
    var cidrParts = cidrString.split('/');

    var addr = cidrParts[0];
    if (cidrParts.length !== 2)
        throw new Error('invalid CIDR subnet: ' + addr);

    var mask = ip.fromPrefixLen(parseInt(cidrParts[1], 10));

    return ip.subnet(addr, mask);
};

ip.not = function (addr) {
    var buff = ip.toBuffer(addr);
    for (var i = 0; i < buff.length; i++) {
        buff[i] = 0xff ^ buff[i];
    }
    return ip.toString(buff);
};

ip.or = function (a, b) {
    a = ip.toBuffer(a);
    b = ip.toBuffer(b);

    // same protocol
    if (a.length === b.length) {
        for (var i = 0; i < a.length; ++i) {
            a[i] |= b[i];
        }
        return ip.toString(a);

        // mixed protocols
    } else {
        var buff = a;
        var other = b;
        if (b.length > a.length) {
            buff = b;
            other = a;
        }

        var offset = buff.length - other.length;
        for (var i = offset; i < buff.length; ++i) {
            buff[i] |= other[i - offset];
        }

        return ip.toString(buff);
    }
};

ip.isEqual = function (a, b) {
    a = ip.toBuffer(a);
    b = ip.toBuffer(b);

    // Same protocol
    if (a.length === b.length) {
        for (var i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    // Swap
    if (b.length === 4) {
        var t = b;
        b = a;
        a = t;
    }

    // a - IPv4, b - IPv6
    for (var i = 0; i < 10; i++) {
        if (b[i] !== 0) return false;
    }

    var word = b.readUInt16BE(10);
    if (word !== 0 && word !== 0xffff) return false;

    for (var i = 0; i < 4; i++) {
        if (a[i] !== b[i + 12]) return false;
    }

    return true;
};

ip.isPrivate = function (addr) {
    return /^(::f{4}:)?10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i
        .test(addr) ||
        /^(::f{4}:)?192\.168\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(addr) ||
        /^(::f{4}:)?172\.(1[6-9]|2\d|30|31)\.([0-9]{1,3})\.([0-9]{1,3})$/i
            .test(addr) ||
        /^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(addr) ||
        /^(::f{4}:)?169\.254\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(addr) ||
        /^f[cd][0-9a-f]{2}:/i.test(addr) ||
        /^fe80:/i.test(addr) ||
        /^::1$/.test(addr) ||
        /^::$/.test(addr);
};

ip.isPublic = function (addr) {
    return !ip.isPrivate(addr);
};

ip.isLoopback = function (addr) {
    return /^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/
        .test(addr) ||
        /^fe80::1$/.test(addr) ||
        /^::1$/.test(addr) ||
        /^::$/.test(addr);
};

ip.loopback = function (family) {
    //
    // Default to `ipv4`
    //
    family = _normalizeFamily(family);

    if (family !== 'ipv4' && family !== 'ipv6') {
        throw new Error('family must be ipv4 or ipv6');
    }

    return family === 'ipv4' ? '127.0.0.1' : 'fe80::1';
};

ip.toLong = function (ip) {
    var ipl = 0;
    ip.split('.').forEach(function (octet) {
        ipl <<= 8;
        ipl += parseInt(octet);
    });
    return (ipl >>> 0);
};

ip.fromLong = function (ipl) {
    return ((ipl >>> 24) + '.' +
        (ipl >> 16 & 255) + '.' +
        (ipl >> 8 & 255) + '.' +
        (ipl & 255));
};
