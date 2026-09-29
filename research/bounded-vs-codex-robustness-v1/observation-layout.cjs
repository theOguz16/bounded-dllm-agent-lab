'use strict';
const fs = require('node:fs');
const path = require('node:path');

class ObservationLayoutError extends Error {
  constructor(code, cause) {
    super(`observation layout failed: ${code}`, { cause });
    this.name = 'ObservationLayoutError';
    this.code = code;
  }
}

function initializeObservationDirectory(sessionDir, obsId, fileSystem = fs) {
  if (!path.isAbsolute(sessionDir) || !/^R[1-5]-(?:normal|bounded)$/.test(obsId)) {
    throw new ObservationLayoutError('invalid_observation_path');
  }
  let root;
  try { root = fileSystem.lstatSync(sessionDir); }
  catch (error) {
    throw new ObservationLayoutError(error.code === 'ENOENT' ? 'session_root_missing' : 'session_root_unavailable', error);
  }
  if (!root.isDirectory() || root.isSymbolicLink()) throw new ObservationLayoutError('session_root_not_directory');
  try { fileSystem.accessSync(sessionDir, fs.constants.W_OK | fs.constants.X_OK); }
  catch (error) { throw new ObservationLayoutError('session_root_unwritable', error); }

  const parent = path.join(sessionDir, 'observations');
  try { fileSystem.mkdirSync(parent, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new ObservationLayoutError('observation_parent_create_failed', error);
  }
  let parentStat;
  try { parentStat = fileSystem.lstatSync(parent); }
  catch (error) { throw new ObservationLayoutError('observation_parent_unavailable', error); }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new ObservationLayoutError('observation_parent_not_directory');
  }
  try { fileSystem.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK); }
  catch (error) { throw new ObservationLayoutError('observation_parent_unwritable', error); }

  const observationDir = path.join(parent, obsId);
  try { fileSystem.mkdirSync(observationDir, { mode: 0o700 }); }
  catch (error) {
    throw new ObservationLayoutError(error.code === 'EEXIST' ?
      'observation_directory_exists' : 'observation_directory_create_failed', error);
  }
  return observationDir;
}

module.exports = { ObservationLayoutError, initializeObservationDirectory };
