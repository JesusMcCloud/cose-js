/* jshint esversion: 6 */
/* jslint node: true */
'use strict';

const cbor = require('cbor');
const EC = require('elliptic').ec;
const NodeRSA = require('node-rsa');
const crypto = require('crypto');
const common = require('./common');
const Promise = require('any-promise');
const EMPTY_BUFFER = common.EMPTY_BUFFER;
const Tagged = cbor.Tagged;

const SignTag = exports.SignTag = 98;
const Sign1Tag = exports.Sign1Tag = 18;

const AlgFromTags = {};
AlgFromTags[-7] = { 'sign': 'ES256', 'digest': 'SHA-256' };
AlgFromTags[-35] = { 'sign': 'ES384', 'digest': 'SHA-384' };
AlgFromTags[-36] = { 'sign': 'ES512', 'digest': 'SHA-512' };
AlgFromTags[-37] = { 'sign': 'PS256', 'digest': 'SHA-256' };
AlgFromTags[-38] = { 'sign': 'PS384', 'digest': 'SHA-384' };
AlgFromTags[-39] = { 'sign': 'PS512', 'digest': 'SHA-512' };

const COSEAlgToNodeAlg = {
  'ES256': { 'sign': 'p256', 'digest': 'sha256' },
  'ES384': { 'sign': 'p384', 'digest': 'sha384' },
  'ES512': { 'sign': 'p521', 'digest': 'sha512' },
  'PS256': { 'alg': 'pss-sha256', 'saltLen': 32 },
  'PS384': { 'alg': 'pss-sha384', 'saltLen': 48 },
  'PS512': { 'alg': 'pss-sha512', 'saltLen': 64 }
};

function doSign (SigStructure, signer, alg) {
  if (!AlgFromTags[alg]) {
    throw new Error('Unknown algorithm, ' + alg);
  }
  if (!COSEAlgToNodeAlg[AlgFromTags[alg].sign]) {
    throw new Error('Unsupported algorithm, ' + AlgFromTags[alg].sign);
  }

  const ec = new EC(COSEAlgToNodeAlg[AlgFromTags[alg].sign].sign);
  const key = ec.keyFromPrivate(signer.key.d);

  let ToBeSigned = cbor.encode(SigStructure);
  const hash = crypto.createHash(COSEAlgToNodeAlg[AlgFromTags[alg].sign].digest);
  hash.update(ToBeSigned);
  ToBeSigned = hash.digest();
  const signature = key.sign(ToBeSigned);
  const bitLength = Math.ceil(ec.curve._bitLength / 8);
  return Buffer.concat([signature.r.toArrayLike(Buffer, undefined, bitLength), signature.s.toArrayLike(Buffer, undefined, bitLength)]);
}

exports.createSync = function (headers, payload, signers, options) {
  options = options || {};
  let u = headers.u || {};
  let p = headers.p || {};

  p = common.TranslateHeaders(p);
  u = common.TranslateHeaders(u);
  let bodyP = p || {};
  bodyP = (bodyP.size === 0) ? EMPTY_BUFFER : cbor.encode(bodyP);
  if (Array.isArray(signers)) {
    if (signers.length === 0) {
      throw new Error('There has to be at least one signer');
    }
    if (signers.length > 1) {
      throw new Error('Only one signer is supported');
    }
    // TODO handle multiple signers
    const signer = signers[0];
    const externalAAD = signer.externalAAD || EMPTY_BUFFER;
    let signerP = signer.p || {};
    let signerU = signer.u || {};

    signerP = common.TranslateHeaders(signerP);
    signerU = common.TranslateHeaders(signerU);
    const alg = signerP.get(common.HeaderParameters.alg);
    signerP = (signerP.size === 0) ? EMPTY_BUFFER : cbor.encode(signerP);

    const SigStructure = [
      'Signature',
      bodyP,
      signerP,
      externalAAD,
      payload
    ];
    const sig = doSign(SigStructure, signer, alg);
    if (p.size === 0 && options.encodep === 'empty') {
      p = EMPTY_BUFFER;
    } else {
      p = cbor.encode(p);
    }
    const signed = [p, u, payload, [[signerP, signerU, sig]]];
    return cbor.encode(options.excludetag ? signed : new Tagged(SignTag, signed));
  } else {
    const signer = signers;
    const externalAAD = signer.externalAAD || EMPTY_BUFFER;
    const alg = p.get(common.HeaderParameters.alg) || u.get(common.HeaderParameters.alg);
    const SigStructure = [
      'Signature1',
      bodyP,
      externalAAD,
      payload
    ];
    const sig = doSign(SigStructure, signer, alg);
    if (p.size === 0 && options.encodep === 'empty') {
      p = EMPTY_BUFFER;
    } else {
      p = cbor.encode(p);
    }
    const signed = [p, u, payload, sig];
    return cbor.encodeCanonical(options.excludetag ? signed : new Tagged(Sign1Tag, signed));
  }
};

exports.create = function (headers, payload, signers, options) {
  return new Promise((resolve, reject) => {
    const internal = exports.createSync(headers, payload, signers, options);
    resolve(internal);
  });
};

function doVerify (SigStructure, verifier, alg, sig) {
  if (!AlgFromTags[alg]) {
    throw new Error('Unknown algorithm, ' + alg);
  }
  if (!COSEAlgToNodeAlg[AlgFromTags[alg].sign]) {
    throw new Error('Unsupported algorithm, ' + AlgFromTags[alg].sign);
  }
  let msgHash = cbor.encode(SigStructure);

  let pub;
  let ky;

  if (AlgFromTags[alg].sign.startsWith('PS')) {
    ky = new NodeRSA().importKey(verifier.key, 'components-public');
    ky.setOptions({
      'signingScheme': {
        'scheme': COSEAlgToNodeAlg[AlgFromTags[alg].sign].alg.split('-')[0],
        'hash': COSEAlgToNodeAlg[AlgFromTags[alg].sign].alg.split('-')[1],
        'saltLength': COSEAlgToNodeAlg[AlgFromTags[alg].sign].saltLen
      }
    });
    if (!ky.verify(msgHash, sig, 'buffer', 'buffer')) {
      throw new Error('Signature missmatch');
    }
  } else {
    const hash = crypto.createHash(COSEAlgToNodeAlg[AlgFromTags[alg].sign].digest);
    hash.update(msgHash);
    msgHash = hash.digest();
    pub = { 'x': verifier.key.x, 'y': verifier.key.y };
    const ec = new EC(COSEAlgToNodeAlg[AlgFromTags[alg].sign].sign);
    ky = ec.keyFromPublic(pub);
    sig = { 'r': sig.slice(0, sig.length / 2), 's': sig.slice(sig.length / 2) };
    if (!ky.verify(msgHash, sig)) {
      throw new Error('Signature missmatch');
    }
  }
}

function getSigner (signers, verifier) {
  for (let i = 0; i < signers.length; i++) {
    const kid = signers[i][1].get(common.HeaderParameters.kid); // TODO create constant for header locations
    if (kid.equals(Buffer.from(verifier.key.kid, 'utf8'))) {
      return signers[i];
    }
  }
}

function getCommonParameter (first, second, parameter) {
  let result;
  if (first.get) {
    result = first.get(parameter);
  }
  if (!result && second.get) {
    result = second.get(parameter);
  }
  return result;
}

function internalVerify (verifier, options, obj) {
  let type = options.defaultType ? options.defaultType : SignTag;
  if (obj instanceof Tagged) {
    if (obj.tag !== SignTag && obj.tag !== Sign1Tag) {
      throw new Error('Unexpected cbor tag, \'' + obj.tag + '\'');
    }
    type = obj.tag;
    obj = obj.value;
  }

  if (!Array.isArray(obj)) {
    throw new Error('Expecting Array');
  }

  if (obj.length !== 4) {
    throw new Error('Expecting Array of lenght 4');
  }

  let [p, u, plaintext, signers] = obj;

  if (type === SignTag && !Array.isArray(signers)) {
    throw new Error('Expecting signature Array');
  }

  p = (!p.length) ? EMPTY_BUFFER : cbor.decodeFirstSync(p);
  u = (!u.size) ? EMPTY_BUFFER : u;

  let signer = (type === SignTag ? getSigner(signers, verifier) : signers);

  if (!signer) {
    throw new Error('Failed to find signer with kid' + verifier.key.kid);
  }

  if (type === SignTag) {
    const externalAAD = verifier.externalAAD || EMPTY_BUFFER;
    let [signerP, , sig] = signer;
    signerP = (!signerP.length) ? EMPTY_BUFFER : signerP;
    p = (!p.size) ? EMPTY_BUFFER : cbor.encode(p);
    const signerPMap = cbor.decode(signerP);
    const alg = signerPMap.get(common.HeaderParameters.alg);
    const SigStructure = [
      'Signature',
      p,
      signerP,
      externalAAD,
      plaintext
    ];
    doVerify(SigStructure, verifier, alg, sig);
    return plaintext;
  } else {
    const externalAAD = verifier.externalAAD || EMPTY_BUFFER;

    const alg = getCommonParameter(p, u, common.HeaderParameters.alg);
    p = (!p.size) ? EMPTY_BUFFER : cbor.encode(p);
    const SigStructure = [
      'Signature1',
      p,
      externalAAD,
      plaintext
    ];
    doVerify(SigStructure, verifier, alg, signer);
    return plaintext;
  }
}

exports.verify = function (payload, verifier, options) {
  options = options || {};
  return cbor.decodeFirst(payload)
    .then((obj) => {
      return internalVerify(verifier, options, obj);
    });
};

exports.verifySync = function (payload, verifier, options) {
  options = options || {};
  let obj = cbor.decodeFirstSync(payload);
  return internalVerify(verifier, options, obj);
};
