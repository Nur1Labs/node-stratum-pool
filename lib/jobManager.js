var events = require('events');
var crypto = require('crypto');

var bignum = require('bignum');
var vh = require('verushash');

var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');
var zBlockTemplate = require('./zBlockTemplate.js');

var EH_PARAMS_MAP = {
    "125_4": {
        SOLUTION_LENGTH: 106,
        SOLUTION_SLICE: 2,
    },
    "144_5": {
        SOLUTION_LENGTH: 202,
        SOLUTION_SLICE: 2,
    },
    "192_7": {
        SOLUTION_LENGTH: 806,
        SOLUTION_SLICE: 6,
    },
    "200_9": {
        SOLUTION_LENGTH: 2694,
        SOLUTION_SLICE: 6,
    }
};

//Unique extranonce per subscriber
var ExtraNonceCounter = function(configInstanceId){

    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;

    this.next = function(){
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };

    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function(options){
    var maxCounter = !options.coin.isZCashProtocol ? 0xffff : 0xffffffffff;
    var counter = !options.coin.isZCashProtocol ? 0 : 0x0000cccc;

    this.next = function(){
        counter++;
        if (counter % maxCounter === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};
function isHexString(s) {
  var check = String(s).toLowerCase();
  if (check.length % 2) {
    return false;
  }
  for (i = 0; i < check.length; i = i + 2) {
    var c = check[i] + check[i + 1];
    if (!isHex(c))
      return false;
  }
  return true;
}
function isHex(c) {
  var a = parseInt(c, 16);
  var b = a.toString(16).toLowerCase();
  if (b.length % 2) { b = '0' + b; }
  if (b !== c) { return false; }
  return true;
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
var JobManager = module.exports = function JobManager(options) {


    //private members

    var _this = this;
    var jobCounter = new JobCounter(options);

    var shareMultiplier = algos[options.coin.algorithm].multiplier;
    
    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    if (!options.coin.isZCashProtocol) {
        this.extraNoncePlaceholder = Buffer.from('f000000ff111111f', 'hex');
        this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;
    }

    this.currentJob;
    this.validJobs = {};

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    var coinbaseHasher = (function(){
        switch(options.coin.algorithm){
            case 'keccak':
            case 'blake':
            case 'fugue':
            case 'groestl':
                if (options.coin.normalHashing === true)
                    return util.sha256d;
                else
                    return util.sha256;
            default:
                return util.sha256d;
        }
    })();


    var blockHasher = (function () {
        if (!options.coin.isZCashProtocol) {
            switch (options.coin.algorithm) {
                case 'blake':
                case 'blake2s':
                case 'neoscrypt':
                case 'lyra2':
                case 'lyra2re2':
                case 'allium':
                case 'lyra2v2':
                case 'lyra2v3':
                case 'qubit':
                case 'skein':
                case 'x11':
                case 'x16r':
                case 'x16rv2':
                case 'x17':
                case 'odo':
                case 'minotaur':
                case 'groestl':
                case 'groestlmyriad':
                    return function () {
                        return util.reverseBuffer(util.sha256d.apply(this, arguments));
                    }
                case 'scrypt':
                case 'scrypt-og':
                case 'scrypt-jane':
                    if (options.coin.reward === 'POS') {
                        return function (d) {
                            return util.reverseBuffer(hashDigest.apply(this, arguments));
                        };
                    }
                case 'scrypt-n':
                case 'sha1':
                    return function (d) {
                        return util.reverseBuffer(util.sha256d(d));
                    };
                default:
                    return function () {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
            }
        } else {
            return function (d) {
                return util.reverseBuffer(util.sha256d(d));
            };
        }
    })();

    this.updateCurrentJob = !options.coin.isZCashProtocol ? function(rpcData){
        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients,
            options.coin.coinbase
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    } : function(rpcData) {
        var tmpBlockTemplate = new zBlockTemplate(
            jobCounter.next(),
            rpcData,
            _this.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.coin.coinbase,
            options.coin
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    };

    //returns true if processed a new block
    this.processTemplate = !options.coin.isZCashProtocol ? function(rpcData) {
        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
           block height is greater than the one we have */
        var isNewBlock = typeof(_this.currentJob) === 'undefined';
        if  (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;

        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients,
            options.coin.coinbase
        );

        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    } : function (rpcData) {
        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
         block height is greater than the one we have */
        var isNewBlock = typeof(_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;

        var tmpBlockTemplate = new zBlockTemplate(
            jobCounter.next(),
            rpcData,
            _this.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.coin.coinbase,
            options.coin
        );

        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;
    };

    this.processShare = !options.coin.isZCashProtocol ? function(jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, versionMask, isSoloMining) {
        var shareError = function(error){
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                isSoloMining: isSoloMining,
                error: error[1]
            });
            return {error: error, result: null};
        };

        var submitTime = Date.now() / 1000 | 0;

        if (extraNonce2.length / 2 !== _this.extraNonce2Size)
            return shareError([20, 'incorrect size of extranonce2']);

        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId ) {
            return shareError([21, 'job not found']);
        }

        if (nTime.length !== 8) {
            return shareError([20, 'incorrect size of ntime']);
        }

        var nTimeInt = parseInt(nTime, 16);
        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            return shareError([20, 'ntime out of range']);
        }

        if (nonce.length !== 8) {
            return shareError([20, 'incorrect size of nonce']);
        }

        if (!job.registerSubmit(extraNonce1, extraNonce2, nTime, nonce)) {
            return shareError([22, 'duplicate share']);
        }

        var extraNonce1Buffer = Buffer.from(extraNonce1, 'hex');
        var extraNonce2Buffer = Buffer.from(extraNonce2, 'hex');

        var coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer, extraNonce2Buffer);
        var coinbaseHash = coinbaseHasher(coinbaseBuffer);

        var merkleRoot = util.reverseBuffer(job.merkleTree.withFirst(coinbaseHash)).toString('hex');

        var headerBuffer = job.serializeHeader(merkleRoot, nTime, nonce, versionMask);
        var headerHash = hashDigest(headerBuffer, nTimeInt);
        var headerBigNum = bignum.fromBuffer(headerHash, {endian: 'little', size: 32});

        var blockHashInvalid;
        var blockHash;
        var blockHex;

        var shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;

        var blockDiffAdjusted = job.difficulty * shareMultiplier;

        //Check if share is a block candidate (matched network difficulty)
        if (job.target.ge(headerBigNum)){
            blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer).toString('hex');
            blockHash = blockHasher(headerBuffer, nTime).toString('hex');
        } else {
            if (options.emitInvalidBlockHashes)
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerBuffer)).toString('hex');

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99){
                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty){
                    difficulty = previousDifficulty;
                } else{
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }

            }
        }

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff : blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid,
            isSoloMining: isSoloMining
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    } : function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln, isSoloMining) {
        var shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                isSoloMining: isSoloMining,
                error: error[1]
            });
            return {error: error, result: null};
        };

        var submitTime = Date.now() / 1000 | 0;

        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId) {
            return shareError([21, 'job not found']);
        }

        if (nTime.length !== 8) {
            return shareError([20, 'incorrect size of ntime']);
        }

        let nTimeInt = parseInt(nTime.substr(6, 2) + nTime.substr(4, 2) + nTime.substr(2, 2) + nTime.substr(0, 2), 16)

        if (Number.isNaN(nTimeInt)) {
            return shareError([20, 'invalid ntime'])
        }

        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            return shareError([20, 'ntime out of range'])
        }

        if (nonce.length !== 64) {
            return shareError([20, 'incorrect size of nonce']);
        }

        /**
         * TODO: This is currently accounting only for equihash. make it smarter.
         */
        let parameters = options.coin.parameters
        if (!parameters) {
            parameters = {
                N: 200,
                K: 9,
                personalization: 'ZcashPoW'
            }
        }

        let N = parameters.N || 200
        let K = parameters.K || 9
        let expectedLength = EH_PARAMS_MAP[N + '_' + K].SOLUTION_LENGTH || 2694
        let solutionSlice = EH_PARAMS_MAP[N + '_' + K].SOLUTION_SLICE || 0

        if (soln.length !== expectedLength) {
            return shareError([20, 'Error: Incorrect size of solution (' + soln.length + '), expected ' + expectedLength]);
        }

        if (!isHexString(extraNonce2)) {
            return shareError([20, 'invalid hex in extraNonce2']);
        }

        if (!job.registerSubmit(nonce, soln)) {
            return shareError([22, 'duplicate share']);
        }

        var headerBuffer = job.serializeHeader(nTime, nonce); // 144 bytes (doesn't contain soln)
        var headerSolnBuffer = Buffer.concat([headerBuffer, Buffer.from(soln, 'hex')]);
        var headerHash;

        switch (options.coin.algorithm) {
            case 'verushash':
                if (job.rpcData.version > 4 && job.rpcData.solution !== undefined) {
                    // make sure verus solution version matches expected version
                    if (soln.substr(solutionSlice, 2) !== job.rpcData.solution.substr(0, 2)) {
                        return shareError([22, 'invalid solution version']);
                    }

                    headerHash = vh.hash2b1(headerSolnBuffer);
                } else if (job.rpcData.version > 4) {
                    headerHash = vh.hash2b(headerSolnBuffer);
                } else {
                    headerHash = vh.hash(headerSolnBuffer);
                }
                break;
            default:
                headerHash = util.sha256d(headerSolnBuffer);
                break;
        };

        var headerBigNum = bignum.fromBuffer(headerHash, {endian: 'little', size: 32});

        var blockHashInvalid;
        var blockHash;
        var blockHex;

        var shareDiff = evdiff1 / headerBigNum.toNumber() * shareMultiplier;
        var blockDiffAdjusted = job.difficulty * shareMultiplier;

        // check if valid solution
        if (hashDigest(headerBuffer, Buffer.from(soln.slice(solutionSlice), 'hex')) !== true) {
            return shareError([20, 'invalid solution']);
        }

        //check if block candidate
        if (headerBigNum.le(job.target)) {
            blockHex = job.serializeBlock(headerBuffer, Buffer.from(soln, 'hex')).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');
        } else {
            if (options.emitInvalidBlockHashes)
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerSolnBuffer)).toString('hex');

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99) {
                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                } else {
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }

            }
        }

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.reward,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid,
            isSoloMining: isSoloMining
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
