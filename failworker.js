/**
 * Created by mox on 29/03/16.
 * Fatus worker for fail queue
 *
 */


'use strict';
const MODULE_NAME = 'FatusFailWorker';
const FatusWorker = require('./worker');
const MessageJob = require('./messagejob');
const moment = require('moment');
const assert = require('assert');
const util = require('util');
const retry = require('retry');
const async = require('async');


/** the worker for the fatus */
class FatusFailWorker extends FatusWorker {


    /**
     * execute a single peek-execute-pop cycle
     */
    single(){
        let th = this;
        this.iteration = this.iteration+1;
        let msgObj,jobObj;
        try {
            async.waterfall([

                    // get work from queue
                    function top(wfcallback) {
                        console.log(MODULE_NAME + '%s: fetch from queue ', th.name);
                        //th.fetchNewJob(th, wfcallback);
                        th.fetchIteration = 0;
                        th.fetchNewJob(th,wfcallback);
                    },

                    // reserve the job
                    function reserve(msg, wfcallback){
                        if(msg && msg[0] && msg[0].messageId){
                            msgObj = msg[0];
                            console.log( MODULE_NAME + '%s: msg found, reserving %s',th.name,msgObj.messageId);
                            jobObj = new MessageJob(msgObj);
                            jobObj.reserve(th, wfcallback);
                            th.processing = jobObj;
                            th.processingId = msgObj.messageId;
                        }else {
                            console.log( MODULE_NAME + '%s: all queue elements are not processable -retry later- %s',th.name,util.inspect(msgObj));
                            wfcallback(new Error('queue is empty'),null);
                        }
                    },

                    // execute instruction in message
                    function msgExecute(res, wfcallback) {
                        console.log(MODULE_NAME + '%s: executing from queue ', th.name);
                        jobObj.execute(th, wfcallback );
                    },

                    // pop message if ok
                    function postExecute(res, wfcallback){
                        th.popMessageFT(msgObj,th,wfcallback);

                    }

                ],
                // update if error, else ok
                function _onFinish(err,val){
                    if(err && typeof err == 'object' && msgObj && jobObj){
                        jobObj.fails(err);
                        // async error, update message
                        th.updateMsgOnError(jobObj, msgObj, err, th);
                        console.log(MODULE_NAME + '%s: FAILED JOB  %s', th.name, util.inspect(jobObj.getCompleteMsg()));
                    }else if (err){
                        //console.log('NOT PROPERLY FAILED JOB : %s', util.inspect(msgObj));
                    }else{
                        //console.log(MODULE_NAME)
                    }
                    th.processing = null;
                    th.processingId = null;
                    th.emit('runcomplete');
                    // repeat only if stack is not full
                    if(th.iteration<th.STACK_PROTECTION_THRSD && th.fetchIteration<(th.STACK_PROTECTION_THRSD*2)){
                        th.run();
                    }else{
                        console.log(MODULE_NAME + '%s: stack protection threshold, KILLING WORKER',th.name);
                        th.fatus.removeWorker(th.name);
                    }
                });
        }catch(err){
            // sync error, update message
            if(msgObj && jobObj) {
                jobObj.fails(err);
                th.updateMsgOnError(jobObj, msgObj, err, th);
            }
        }
    }


    /**
     * get the fail queue size
     * @param fatus
     * @param onGet
     */
    getQueueSize(fatus,onGet){
        fatus.getFailSize(onGet);
    }

    /**
     * get a new job from the fail queue
     * @param th
     * @param wfcallback
     * @override
     */
    fetchNewJob(th, wfcallback) {
        th.fetchIteration = th.fetchIteration +1;
        if(th.fetchIteration<(th.STACK_PROTECTION_THRSD*2)) {
            let NOW = moment();
            th.fatus.getFailTop(function onGet(err, msg) {
                if (!err && msg && msg[0] && msg[0].messageText) {
                    let reservedCondition = msg[0].messageText.reserved && Math.abs(moment(msg[0].messageText.dtReserve).diff(NOW,'s')) < th.MAX_RESERVATION_TIME && msg[0].messageText.reserver != th.name;
                    if (reservedCondition) {
                        return th.fetchNewJob(th, wfcallback);
                    }else{
                        wfcallback(err, msg);
                    }
                }else{
                    wfcallback(err, null);
                }
            });
        }else{
            wfcallback(null,null);
        }
    }

    /**
     * pop a message from the fail queue, while completed,with fault tollerance
     * @param msg the message to pop
     * @param th the reference to the worker
     * @param callback classic err/res callback
     */
    popMessageFT(msg, th, callback){
        th.emit('pop',msg.messageText);
        var ftOperation = retry.operation({
            retries: 10,                    // number of retry times
            factor: 1,                      // moltiplication factor for every rerty
            minTimeout: 1 * 1000,           // minimum timeout allowed
            maxTimeout: 1 * 1000            // maximum timeout allowed
        });
        console.log('======POP: ' + util.inspect(msg));
        ftOperation.attempt(
            function (currentAttempt){
                th.fatus.popFail(msg,function(err,res){
                    if (ftOperation.retry(err)){
                        return;
                    }
                    callback(err ? ftOperation.mainError() : null, res);
                })
            });
    }

    /**update a messase in the queue, with fault tollerance
     * run a update
     * @param msg
     * @param th
     * @param callback
     */
    updateMessageFT(msg, th, callback){
        var ftOperation = retry.operation({
            retries: 10,                    // number of retry times
            factor: 1,                      // moltiplication factor for every rerty
            minTimeout: 1 * 1000,           // minimum timeout allowed
            maxTimeout: 1 * 1000            // maximum timeout allowed
        });
        var fatus = th.fatus;
        ftOperation.attempt(
            function (currentAttempt){
                fatus.updateFail(msg,function(err,res){
                    if (ftOperation.retry(err)){
                        //console.log(MODULE_NAME + '%s: err on updateMessage for msg %s ',th.name,msg.messageId);
                        return;
                    }
                    callback(err ? ftOperation.mainError() : null, res);
                })
            });
    }
}


/** Exports */
module.exports = FatusFailWorker;