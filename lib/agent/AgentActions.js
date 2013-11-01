/*
 * == TIDEPOOL LICENSE ==
 * Copyright (C) 2013 Tidepool Project
 * 
 * This source code is subject to the terms of the Tidepool Open Data License, v. 1.0.
 * If a copy of the license was not provided with this file, you can obtain one at:
 *     http://tidepool.org/license/
 * 
 * == TIDEPOOL LICENSE ==
 */

var util = require('util');
var fs = require('fs');
var path = require('path');
var child_process = require('child_process');

var shell = require('shelljs');
var async = require('async');

var fn = require('../fn.js');

var EMPTY_BUNDLE = { binary: { name: '_empty', version: '_empty'},  config: { name: '_empty', version: '_empty'} };

function AgentActions(s3, config) {
  this.s3 = s3;
  this.config = config;
  this.slots = {};

  this.bootstrap();
}

AgentActions.prototype.bootstrap = function()
{
  var deployDir = this.config.deployDir;
  shell.mkdir('-p', deployDir);

  var ids = shell.ls(deployDir);
  ids.forEach(this.addListing.bind(this));
  for (var slot in this.slots) {
    if (this.slots[slot].state === 'RUNNING') {
      var internal = this.slots[slot]._internal;
      this.watchPid(slot, internal.pid, internal.pidFile);
    }
  }
}

AgentActions.prototype.createSlot = function(params, bundle, res, cb) {
  var slot = params.slot;

  var slotDir = this.deployBase(slot);
  if (fs.existsSync(slotDir)) {
    return cb();
  }

  shell.mkdir('-p', path.join(slotDir, '0'));
  fs.writeFileSync(this.bundleFile(slot, 0), JSON.stringify(EMPTY_BUNDLE));
  this.addListing(slot);
  return cb();
}

AgentActions.prototype.deleteSlot = function(params, bundle, res, cb) {
  var slot = params.slot;

  if (this.slots[slot] != null && this.slots[slot].state == 'RUNNING') {
    return cb("Cannot delete slot with a running process, call stop first.");
  }

  var slotDir = this.deployBase(slot);
  if (fs.existsSync(slotDir)) {
    console.info("Deleting slot[%s], removing directory[%s]", slot, slotDir);
    shell.rm('-r', slotDir);
  }
  else {
    console.info("Asked to delete slot[%s], but dir[%s] wasn't there.", slot, slotDir);
  }

  return cb();
}

AgentActions.prototype.load = function(params, bundle, res, cb) {
  var self = this;
  var slot = params.slot;

  console.log("Loading [%j]", bundle);

  var deployCount = this.currDeployCount(slot);
  if (this.isRunning(slot, deployCount)) {
    return cb("Currently running, please stop first.");
  }

  var binaryFilename = util.format('%s-%s.tar.gz', bundle.binary.name, bundle.binary.version);
  var configFilename = util.format('config-%s.tar.gz', bundle.config.version);
  
  var binaryKeyPath = util.format('deploy/%s', bundle.binary.name);
  var configKeyPath = util.format('config/%s/%s', bundle.binary.name, bundle.config.name);

  var nextDeployCount = deployCount + 1;
  var outDir = this.deployDir(slot, nextDeployCount);

  async.series(
    [
      this.loadFile.bind(this, 'tidepool-binaries', binaryKeyPath , slot, binaryFilename),
      this.loadFile.bind(this, 'tidepool-config', configKeyPath, slot, configFilename),
      fn.asyncify(shell.mkdir.bind(shell, '-p', outDir)),
      this.expandTar.bind(this, this.tmpFile(slot, binaryFilename), outDir),
      this.expandTar.bind(this, this.tmpFile(slot, configFilename), path.join(outDir, path.basename(binaryFilename, '.tar.gz'))),
      fs.writeFile.bind(fs, this.bundleFile(slot, nextDeployCount), JSON.stringify(bundle, null, 2)),
      fn.asyncify(self.addListing.bind(self, slot))
    ],
    function(err, results) {
      var storageDir = self.tmpDir(slot);
      console.info("Removing temporary directory[%s]", storageDir)
      shell.rm('-r', storageDir);

      if (err) {
        return cb(err);
      }
      res.send(200);
      cb();
    }
  );
}

AgentActions.prototype.unload = function(params, bundle, res, cb) {
  var slot = params.slot;

  if (this.slots[slot] == null) {
    return cb();
  }

  if (this.slots[slot].state == 'RUNNING') {
    return cb("Cannot unload running process, call stop first.");
  }

  console.info("Unloading deploy at slot[%s]", slot);

  var deployCount = this.currDeployCount(slot) + 1;
  var deployDir = this.deployDir(slot, deployCount);
  shell.mkdir('-p', deployDir);
  fs.writeFileSync(this.bundleFile(slot, deployCount), JSON.stringify(EMPTY_BUNDLE));
  this.addListing(slot);
  return cb();
}

AgentActions.prototype.start = function(params, bundle, res, cb) {
  var slot = params.slot;
  var deployCount = this.currDeployCount(slot);

  if (deployCount == 0) {
    return cb(util.format("slot[%s] is not deployed.", slot));
  }

  var deployDir = this.deployDir(slot, deployCount);

  var bundle = JSON.parse(fs.readFileSync(this.bundleFile(slot, deployCount)));

  if (isRunning(slot, deployCount)) {
    return cb("Already running");
  }

  var workingDir = path.join(deployDir, util.format('%s-%s', bundle.binary.name, bundle.binary.version));
  var startScript = path.join(workingDir, 'start.sh');

  if (! fs.existsSync(startScript)) {
    return cb("No start.sh script, make sure your binary artifact has a start.sh script bundled.");
  }

  console.info("Starting binary[%j], config[%j] -- Running startScript[%s].", bundle.binary, bundle.config, startScript);

  out = fs.openSync(path.join(deployDir, 'out.log'), 'a');
  err = fs.openSync(path.join(deployDir, 'out.log'), 'a');
  var child = child_process.spawn(startScript, [], { cwd: workingDir, detached: true, stdio: [ 'ignore', out, err]})
  child.on('error', function(err) { console.error(err); })

  fs.writeFileSync(runningFile, String(child.pid));
  this.watchPid(slot, child.pid, runningFile);

  child.unref();

  this.slots[slot].state = 'RUNNING';
  res.send(200);
  cb();
}

AgentActions.prototype.stop = function(params, bundle, res, cb) {
  var self = this;
  var slot = params.slot;

  var pidFile = this.pidFile(slot, this.currDeployCount(slot));
  if (! fs.existsSync(pidFile)) { 
    res.send(200);
    return cb();
  }

  var pid = String(fs.readFileSync(pidFile));
  console.info("Killing pid[%s].", pid);

  shell.exec(util.format("kill %s", pid), {silent:true}, function(exitCode, content) {
    if (exitCode != 0) {
      console.warn("kill pid[%s] failed with code[%s], content[%s]", pid, exitCode, content);
      return cb("Failed to kill process.");
    }

    shell.rm(pidFile);
    self.slots[slot].state = 'STOPPED';
    res.send(200);
    cb();
  });

  setTimeout(
    function(){
      if (self.processRunning(pid)) {
        console.error("pid[%s] still running after kill.  Being a little more persuasive.");
        shell.exec(util.format("kill -9 %s", pid), {silent:true});
        self.slots[slot].state = 'STOPPED';
      }
    },
    2 * 60 * 1000
  ).unref();
}

AgentActions.prototype.show = function(params, bundle, res, cb) {
  res.json(this.slots);
  return cb();
}

AgentActions.prototype.getSlots = function() {
  return this.slots;
}

AgentActions.prototype.tmpDir = function(slot) {
  return path.join(shell.tempdir(), String(slot));
}

AgentActions.prototype.tmpFile = function(slot, file) {
  return path.join(this.tmpDir(slot), file);
}

AgentActions.prototype.currDeployCount = function(slot) {
  if (typeof slot === 'undefined') {
    throw new Error("must specify slot parameter");
  }

  var deployBase = this.deployBase(slot);
  if (fs.existsSync(deployBase)) {
    shell.mkdir('-p', deployBase);
  }

  var deploys = shell.ls(deployBase);
  return Math.max.apply(null, [0].concat(deploys.map(Number)));
}

AgentActions.prototype.deployBase = function(slot) {
  return path.join(this.config.deployDir, String(slot));
}

AgentActions.prototype.deployDir = function(slot, deployCount) {
  return path.join(this.deployBase(slot), String(deployCount));   
}

AgentActions.prototype.bundleFile = function(slot, deployCount) {
  return path.join(this.deployDir(slot, deployCount), 'deployed-bundle.json');
}

AgentActions.prototype.pidFile = function(slot, deployCount) {
  return path.join(this.deployDir(slot, deployCount), 'running.pid');
}

AgentActions.prototype.loadFile = function(bucket, keyBase, slot, file, cb) {
  var filename = this.tmpFile(slot, file);
  if (fs.existsSync(filename)) {
    console.info("File[%s] exists, deleting.", filename);
    shell.rm(filename);
  }

  var tmpPath = path.dirname(filename);
  if (! fs.existsSync(tmpPath)) {
    console.info("Making dir[%s].", tmpPath);
    shell.mkdir('-p', tmpPath);
  }

  var outStream = fs.createWriteStream(filename);
  var done = false;
  var s3GetObject = { Bucket: bucket, Key: keyBase + '/' + file };
  console.info("Downloading [%j] to [%s]", s3GetObject, filename);
  this.s3.getObject(s3GetObject)
    .on('httpData', function(chunk) { outStream.write(chunk); })
    .on('httpDone', function() { outStream.end(); if (!done) { done = true; cb(); } })
    .on('error', function(err) { 
      outStream.end(); 
      if (!done) { 
        done = true; 
        err.message = util.format('%s: %j', err.message, s3GetObject);
        cb(err); 
      } 
    })
    .send();
}

AgentActions.prototype.expandTar = function(tarFile, outDir, cb) {
  console.info("Expanding [%s] to [%s]", tarFile, outDir);
  child_process.exec(util.format('tar xzf %s', tarFile), {cwd: outDir}, function(err, stdout, stdin) {
    if (err != null) {
      console.error("Unable to untar[%s]:", tarFile, err.message);
      console.log(err.stack);
    }
    return cb(err);
  });
}

AgentActions.prototype.isRunning = function(slot, deployCount) {
  var runningFile = this.pidFile(slot, deployCount);
  if (fs.existsSync(runningFile)) {
    if (! this.cleanPid(slot, String(fs.readFileSync(runningFile)), runningFile)) {
      return true
    }
  }
  return false;
}

AgentActions.prototype.processRunning = function(pid) {
  return shell.exec(util.format("ps %s", pid), {silent: true}).output.indexOf(pid) >= 0
}

AgentActions.prototype.cleanPid = function(slot, pid, pidFile) {
  if ( (!this.processRunning(pid)) && String(fs.readFileSync(pidFile)) === String(pid)) {
    console.warn("Process[%s] with pid[%s] disdappeared...", slot, pid);
    this.slots[slot].state = 'DISDAPPEARED';
    shell.rm(pidFile);
    return true;
  }
  return false;
}

AgentActions.prototype.watchPid = function(slot, pid, pidFile) {
  if (fs.existsSync(pidFile)) {
    if (! this.cleanPid(slot, pid, pidFile)) {
      return setTimeout(this.watchPid.bind(this, slot, pid, pidFile), 60 * 1000).unref();
    }
    console.info("pid[%s] disappeared!", pid);
  }
}

AgentActions.prototype.addListing = function(slot) {
  var currDeploy = this.currDeployCount(slot);

  var bundleFile = this.bundleFile(slot, currDeploy);
  while (! fs.existsSync(bundleFile)) {
    console.warn("Expected bundleFile[%s] to exist, but it didn't.  Deleting.", bundleFile);
    shell.rm('-r', this.deployDir(slot, currDeploy));
    
    --currDeploy;
    if (currDeploy < 0) {
      var slotDir = this.deployBase(slot);
      console.error("Unable to find usable deploy.  Deleting slot directory[%s]", slotDir);
      shell.rm('-r', slotDir);
      return;
    }
    bundleFile = this.bundleFile(slot, currDeploy);
  } 

  var bundle = JSON.parse(fs.readFileSync(bundleFile));
  var _internal = {};

  var pidFile = this.pidFile(slot, currDeploy);
  if (fs.existsSync(pidFile)) {
    _internal.pidFile = pidFile;
    var pid = fs.readFileSync(pidFile)
    if (this.processRunning(pid)) {
      _internal.pid = pid;
      bundle.state = 'RUNNING';
    }
    else {
      bundle.state = 'STOPPED';
    }
  }
  else {
    bundle.state = 'STOPPED';
  }

  bundle._internal = _internal;
  this.slots[slot] = bundle;
}

module.exports = AgentActions;
 