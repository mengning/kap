import {homedir} from 'os';
import settings from 'electron-settings';
import objectPath from 'object-path';
import {track} from '../main/analytics';
/* Deleted imports for not used
import {app} from 'electron';
import aperture from 'aperture';
*/

const DEFAULTS = {
  kapturesDir: `${homedir()}/Movies/Kaptures`,
  openOnStartup: false,
  allowAnalytics: true,
  showCursor: true,
  highlightClicks: false,
  hideDesktopIcons: false,
  doNotDisturb: false,
  record60fps: false,
  recordKeyboardShortcut: true,
  recordAudio: false,
  audioInputDeviceId: null,
  dimensions: {
    height: 512,
    width: 512,
    ratio: [1, 1],
    ratioLocked: false
  }
};

const volatiles = {
  cropperWindow: {
    size: {
      width: 512,
      height: 512
    },
    position: {
      x: 'center',
      y: 'center'
    }
  }
};

/* Deleted for Non-Mac
const sync = () => {
  settings.setSync('openOnStartup', app.getLoginItemSettings().openAtLogin);
};
*/

export const init = async () => {
  /* Modified for non-existed functions. Replaced by self-defined.
  settings.defaults(DEFAULTS);
  settings.applyDefaultsSync();
  */
  for (const key in DEFAULTS) {
    if (!settings.get(key)) {
      settings.set(key, DEFAULTS[key]);
    }
  }
  // Deleted for Non-Mac: sync();

  /* Deleted. I don't know whether Windows should get an audioDeviceId. This is a issue to Solve.
  const devices = await aperture.audioDevices();
  if (devices.length > 0) {
    settings.setSync('audioInputDeviceId', devices[0].id);
  }
  */
};

export const get = key => {
  // Deleted for Non-Mac: sync();
  /* Modified for non-existed functions. Replaced by self-defined.
  return objectPath.get(volatiles, key) || settings.getSync(key);
  */
  return objectPath.get(volatiles, key) || settings.get(key);
};

export const getAll = () => {
  // Deleted for Non-Mac: sync();
  /* Modified for non-existed functions. Replaced by self-defined.
  return Object.assign({}, volatiles, settings.getSync());
  */
  return Object.assign({}, volatiles, settings.getAll());
};

export const set = (key, value, {volatile = false} = {}) => {
  if (volatile) {
    return objectPath.set(volatiles, key, value);
  }

  if (key !== 'dimensions' && typeof value === 'boolean') {
    track(`settings/${key}/toggled/${value}`);
  }

  /* Modified for non-existed functions. Replaced by self-defined.
  settings.setSync(key, value);
  */
  settings.set(key, value);
};

/* Modified for non-existed functions. Replaced by self-defined.
export const observe = (keyPath, handler) => settings.observe(keyPath, handler);
*/
export const observe = (keyPath, handler) => settings.watch(keyPath, handler);
