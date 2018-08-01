import path from 'path';
import fs from 'fs';
import {app, BrowserWindow, ipcMain, Menu, screen, globalShortcut, dialog, Notification} from 'electron';
import isDev from 'electron-is-dev';
import util from 'electron-util';
import {init as initErrorReporter} from '../common/reporter';
import {init as initLogger} from '../common/logger';
import * as settings from '../common/settings-manager';
import {createMainTouchbar, createRecordTouchbar, createEditorTouchbar} from './touch-bar';
import {init as initAutoUpdater} from './auto-updater';
import {init as initAnalytics, track} from './analytics';
import {applicationMenu, cogMenu} from './menus';
import plugins from './plugins';

require('electron-debug')();

const {wasOpenedAtLogin} = app.getLoginItemSettings();

const menubar = require('menubar')({
  index: `file://${__dirname}/../renderer/views/main.html`,
  icon: path.join(__dirname, '..', '..', 'static', 'menubarDefaultTemplate.png'),
  width: 320,
  height: 500,
  preloadWindow: true,
  transparent: true,
  resizable: false,
  movable: false, // Disable detaching the main window
  minWidth: 320
});

const cropperWindowBuffer = 2;
let appState = 'initial';
let cropperWindow;
let mainWindowIsDetached = false;
let mainWindow;
let mainWindowIsNew = true;
let positioner;
let editorWindow;
let prefsWindow;
let shouldStopWhenTrayIsClicked = false;
let tray;
let recording = false;
let playing = true;
let preparingToRecord = false;
let timeStartedRecording;

const discardVideo = () => {
  track('file/discarded');

  // Discard the source video
  fs.unlink(editorWindow.kap.videoFilePath, () => {});

  // For some reason it doesn't close when called in the same tick
  setImmediate(() => {
    editorWindow.close();
  });

  menubar.setOption('hidden', false);
  if (mainWindowIsDetached === true) {
    mainWindow.show();
  } else {
    app.dock.hide(); // Mac专用，windows可以去掉
  }
};

// 下面三个基于TouchBar操作，Windows下需要删除或改造
const mainTouchbar = createMainTouchbar({
  onAspectRatioChange: aspectRatio => mainWindow.webContents.send('change-aspect-ratio', aspectRatio),
  onCrop: () => mainWindow.webContents.send('crop')
});

const recordTouchBar = (isRecording, isPreparing = false) => createRecordTouchbar({
  isRecording,
  isPreparing,
  onAspectRatioChange: aspectRatio => mainWindow.webContents.send('change-aspect-ratio', aspectRatio),
  onRecord: status => mainWindow.webContents.send(status ? 'stop-recording' : 'prepare-recording')
});

const editorTouchbar = isPlaying => createEditorTouchbar({
  isPlaying,
  onDiscard: () => discardVideo(),
  onSelectPlugin: (pluginName, format) => editorWindow.webContents.send('run-plugin', pluginName, format),
  onTogglePlay: status => editorWindow.webContents.send('toggle-play', status)
});

settings.init();

ipcMain.on('set-main-window-size', (event, args) => {
  if (args.width && args.height && mainWindow) {
    [args.width, args.height] = [parseInt(args.width, 10), parseInt(args.height, 10)];
    mainWindow.setSize(args.width, args.height, true); // True == animate
    event.returnValue = true; // Give true to sendSync caller
  }
});

ipcMain.on('show-options-menu', (event, coordinates) => {
  if (coordinates && coordinates.x && coordinates.y) {
    coordinates.x = parseInt(coordinates.x.toFixed(), 10);
    coordinates.y = parseInt(coordinates.y.toFixed(), 10);

    cogMenu.popup(coordinates.x + 4, coordinates.y); // 4 is the magic number ✨
  }
});

const closeCropperWindow = () => {
  cropperWindow.close();
  mainWindow.setAlwaysOnTop(false); // TODO send a PR to `menubar`
  menubar.setOption('alwaysOnTop', false);
};

const setCropperWindowOnBlur = (closeOnBlur = true) => {
  cropperWindow.on('blur', () => {
    if (!mainWindow.isFocused() &&
        !cropperWindow.webContents.isDevToolsFocused() &&
        !mainWindow.webContents.isDevToolsFocused() &&
        !recording &&
        closeOnBlur === true) {
      closeCropperWindow();
    }
  });
};

// 下一节更新TouchBar，Windows下需要删除或重构
const updateRecordingTouchbar = (isRecording, isPreparing = false) => {
  const recordTouchBarInstance = recordTouchBar(isRecording, isPreparing);
  if (cropperWindow) {
    cropperWindow.setTouchBar(recordTouchBarInstance);
  }
  if (mainWindow) {
    mainWindow.setTouchBar(recordTouchBarInstance);
  }
};

const openCropperWindow = (size = {}, position = {}, options = {}) => {
  options = Object.assign({}, {
    closeOnBlur: true
  }, options);

  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1); // 后两个参数仅在mac下起作用
  menubar.setOption('alwaysOnTop', true);

  if (cropperWindow) {
    cropperWindow.focus();
  } else {
    let {width = 512, height = 512} = settings.get('cropperWindow.size');
    width = size.width || width;
    height = size.height || height;
    let {x, y} = settings.get('cropperWindow.position');
    x = position.x === undefined ? x : position.x;
    y = position.y === undefined ? y : position.y;
    cropperWindow = new BrowserWindow({
      width: width + cropperWindowBuffer,
      height: height + cropperWindowBuffer,
      minHeight: 100 + cropperWindowBuffer,
      minWidth: 100 + cropperWindowBuffer,
      frame: false,
      transparent: true,
      resizable: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      x: x - (cropperWindowBuffer / 2),
      y: y - (cropperWindowBuffer / 2)
    });
    mainWindow.webContents.send('cropper-window-opened', {width, height, x, y});
    cropperWindow.loadURL(`file://${__dirname}/../renderer/views/cropper.html`);
    cropperWindow.setIgnoreMouseEvents(false); // TODO this should be false by default
    cropperWindow.setAlwaysOnTop(true, 'screen-saver');
    updateRecordingTouchbar(false, false);

    if (isDev) {
      cropperWindow.openDevTools({mode: 'detach'});
      cropperWindow.webContents.on('devtools-opened', () => {
        setCropperWindowOnBlur(options.closeOnBlur);
        mainWindow.focus();
      });
    } else {
      setCropperWindowOnBlur(options.closeOnBlur);
    }

    cropperWindow.on('closed', () => {
      cropperWindow = undefined;
      mainWindow.webContents.send('cropper-window-closed');
      mainWindow.setTouchBar(mainTouchbar);
    });

    cropperWindow.on('resize', () => {
      const size = {};
      [size.width, size.height] = cropperWindow.getSize();
      mainWindow.webContents.send('cropper-window-new-size', size);
      settings.set('cropperWindow.size', size, {volatile: true});
    });

    cropperWindow.on('moved', () => {
      let [x, y] = cropperWindow.getPosition();

      // TODO: we need to implement some logic to, at the same time, allow the user
      // to move the window to another display, but don't allow them to move the window
      // to ouside of a display. it should be tricky to implement – how can we decide if
      // a movement is valid – that is, the window is being moved to another display
      // or it's simply being moved to outside of a display?
      if (screen.getAllDisplays().length === 1) {
        const [width, height] = cropperWindow.getSize();
        const {width: screenWidth, height: screenHeight} = screen.getPrimaryDisplay().bounds;
        const x2 = x + width;
        const y2 = y + height;

        const padding = cropperWindowBuffer / 2;

        if (x < -padding || y < -padding || x2 > screenWidth + padding || y2 > screenHeight + padding) {
          x = x < -padding ? -padding : x;
          x = x2 > screenWidth + padding ? screenWidth + padding - width : x;
          y = y < -padding ? -padding : y;
          y = y2 > screenHeight + padding ? screenHeight + padding - height : y;
          cropperWindow.setPosition(x, y, true);
        }
      }

      settings.set('cropperWindow.position', {x, y}, {volatile: true});
    });
  }
};

ipcMain.on('set-cropper-window-size', (event, args) => {
  if (!args.width || !args.height) {
    return;
  }

  [args.width, args.height] = [parseInt(args.width, 10), parseInt(args.height, 10)];

  if (cropperWindow) {
    cropperWindow.setSize(args.width + cropperWindowBuffer, args.height + cropperWindowBuffer, true); // True == animate
  } else {
    openCropperWindow(args);
    mainWindow.focus();
  }
});

ipcMain.on('activate-app', async (event, appName, {width, height, x, y}) => {
  if (cropperWindow) {
    cropperWindow.close();
  }
  // Deleted for Mac: await activateWindow(appName);
  mainWindow.show();
  openCropperWindow({width, height}, {x, y}, {closeOnBlur: false});
});

ipcMain.on('open-cropper-window', (event, size, position) => {
  if (cropperWindow) {
    cropperWindow.close();
  }

  openCropperWindow(size, position);
});

ipcMain.on('close-cropper-window', () => {
  if (cropperWindow && !recording) {
    mainWindow.setTouchBar(mainTouchbar);
    closeCropperWindow();
  }
});

const resetMainWindowShadow = () => {
  const size = mainWindow.getSize();

  setTimeout(() => {
    size[1]++;
    mainWindow.setSize(...size, true);
  }, 100);
  setTimeout(() => {
    size[1]--;
    mainWindow.setSize(...size, true);
  }, 110);
};

const resetTrayIcon = () => {
  appState = 'initial'; // If the icon is being reseted, we are not recording anymore
  shouldStopWhenTrayIsClicked = false;
  tray.setImage(path.join(__dirname, '..', '..', 'static', 'menubarDefaultTemplate.png')); // TODO：换成ICO
  menubar.setOption('alwaysOnTop', false);
  mainWindow.setAlwaysOnTop(false);
};

const animateIcon = () => new Promise(resolve => {
  const interval = 20;
  let i = 0;

  const next = () => {
    setTimeout(() => {
      const number = String(i++).padStart(5, '0');
      const filename = `loading_${number}Template.png`; // TODO: 换成ICO

      try {
        tray.setImage(path.join(__dirname, '..', '..', 'static', 'menubar-loading', filename));

        // This is needed as there some race condition in the existing
        // code that activates this even when it's not recording…
        if (appState === 'recording') {
          next();
        }
      } catch (err) {
        resolve();
      }
    }, interval);
  };

  next();
});

const setTrayStopIcon = () => {
  shouldStopWhenTrayIsClicked = true;
  animateIcon();
};

// Open the Preferences Window
const openPrefsWindow = () => {
  if (prefsWindow) {
    return prefsWindow.show();
  }

  prefsWindow = new BrowserWindow({
    width: 480,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: 'hiddenInset',
    show: false
  });

  prefsWindow.on('close', () => {
    prefsWindow = undefined;
  });

  prefsWindow.loadURL(`file://${__dirname}/../renderer/views/preferences.html`);
  prefsWindow.on('ready-to-show', () => {
    prefsWindow.show();
    track('preferences/opened');
  });
};

const getCropperWindow = () => {
  return cropperWindow;
};

app.on('ready', () => {
  util.enforceMacOSAppLocation(); // TODO：移除？

  // Ensure all plugins are up to date
  plugins.upgrade().catch(() => {});

  if (settings.get('recordKeyboardShortcut')) {
    globalShortcut.register('Cmd+Shift+5', () => { // TODO：换成Windows快捷键
      const recording = (appState === 'recording');
      mainWindow.webContents.send((recording) ? 'stop-recording' : 'prepare-recording');
    });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

const getEditorWindow = () => {
  return editorWindow;
};

menubar.on('after-create-window', () => {
  let expectedWindowPosition;
  const currentWindowPosition = {};
  mainWindow = menubar.window;
  mainWindow.setTouchBar(mainTouchbar);

  app.kap = {mainWindow, getCropperWindow, getEditorWindow, openPrefsWindow, settings, cropperWindowBuffer};
  if (isDev) {
    mainWindow.openDevTools({mode: 'detach'});
  }

  const recomputeExpectedWindowPosition = () => {
    expectedWindowPosition = positioner.calculate('trayCenter', tray.getBounds());
  };

  const recomputeCurrentWindowPosition = () => {
    [currentWindowPosition.x, currentWindowPosition.y] = mainWindow.getPosition();
  };

  mainWindow.on('blur', () => {
    if (cropperWindow && !cropperWindow.isFocused() && !recording) {
      // Close the cropper window if the main window loses focus and the cropper window
      // is not focused
      mainWindow.setTouchBar(mainTouchbar);
      closeCropperWindow();
    }

    recomputeExpectedWindowPosition();
    recomputeCurrentWindowPosition();
    if (expectedWindowPosition.x !== currentWindowPosition.x || expectedWindowPosition.y !== currentWindowPosition.y) { // This line is too long
      menubar.setOption('x', expectedWindowPosition.x);
      menubar.setOption('y', expectedWindowPosition.y);
    } else { // Reset the position if the window is back at it's original position
      menubar.setOption('x', undefined);
      menubar.setOption('y', undefined);
    }
  });

  let wasStuck = true;
  mainWindow.on('move', () => { // Unfortunately this is just an alias for 'moved'
    recomputeExpectedWindowPosition();
    recomputeCurrentWindowPosition();
    const diff = {
      x: Math.abs(expectedWindowPosition.x - currentWindowPosition.x),
      y: Math.abs(expectedWindowPosition.y - currentWindowPosition.y)
    };

    if (diff.y < 50 && diff.x < 50) {
      if (!wasStuck) {
        mainWindow.webContents.send('stick-to-menubar');
        app.dock.hide(); // TODO：移除
        resetMainWindowShadow();
        wasStuck = true;
        mainWindowIsDetached = false;
      }
      // The `move` event is called when the user reselases the mouse button
      // because of that, we need to move the window to it's expected position, since the
      // user will never release the mouse in the *right* position (diff.[x, y] === 0)
      tray.setHighlightMode('always');
      positioner.move('trayCenter', tray.getBounds());
    } else if (wasStuck) {
      mainWindow.webContents.send('unstick-from-menubar');
      app.dock.show(); // TODO：移除
      setTimeout(() => mainWindow.show(), 250);
      setTimeout(() => resetMainWindowShadow(), 100);
      tray.setHighlightMode('never');
      wasStuck = false;
      mainWindowIsDetached = true;
    }
  });

  tray = menubar.tray;
  positioner = menubar.positioner;

  tray.on('click', () => {
    if (preparingToRecord) {
      tray.setHighlightMode('never');
      return mainWindow.hide();
    }
    if (editorWindow) {
      return editorWindow.show();
    }
    if (mainWindowIsNew) {
      mainWindowIsNew = false;
      positioner.move('trayCenter', tray.getBounds()); // Not sure why the fuck this is needed (ﾉಠдಠ)ﾉ︵┻━┻
    }
    if (appState === 'recording' && shouldStopWhenTrayIsClicked) {
      mainWindow.webContents.send('stop-recording');
    } else if (app.dock.isVisible()) {
      mainWindow.show();
    }
  });

  mainWindow.on('hide', () => {
    if (appState === 'recording') {
      setTrayStopIcon();
    }
  });

  mainWindow.on('show', () => {
    mainWindow.webContents.send('reload-apps');
  });

  menubar.on('show', () => {
    if (mainWindowIsDetached) {
      tray.setHighlightMode('never');
    }
  });

  app.on('activate', () => { // == dockIcon.onclick  Mac里的，在Windows里应该用不上
    if (!mainWindow.isVisible() && editorWindow === undefined) {
      mainWindow.show();
    }
  });

  mainWindow.once('ready-to-show', () => {
    // If Kap was launched at login, don't show the window
    if (wasOpenedAtLogin) {
      return;
    }

    positioner.move('trayCenter', tray.getBounds()); // Not sure why the fuck this is needed (ﾉಠдಠ)ﾉ︵┻━┻
    mainWindow.show();
  });

  mainWindowIsNew = true;

  initAutoUpdater(mainWindow);
  initAnalytics();
  initErrorReporter();
  initLogger(mainWindow);

  Menu.setApplicationMenu(applicationMenu);
});

ipcMain.on('start-recording', () => {
  mainWindow.webContents.send('start-recording');
});

ipcMain.on('will-start-recording', () => {
  recording = true;
  preparingToRecord = true;
  updateRecordingTouchbar(false, true);
  if (cropperWindow) {
    cropperWindow.setResizable(false);
    cropperWindow.setIgnoreMouseEvents(true);
    cropperWindow.setAlwaysOnTop(true);
  }

  timeStartedRecording = Date.now();
  track(`recording/${timeStartedRecording}/started`);

  appState = 'recording';
  setTrayStopIcon();
  if (!mainWindowIsDetached) {
    mainWindow.hide();
    tray.setHighlightMode('never');
  }
});

ipcMain.on('did-start-recording', () => {
  preparingToRecord = false;
  updateRecordingTouchbar(true, false);
});

ipcMain.on('stopped-recording', () => {
  resetTrayIcon();
  track(`recording/${timeStartedRecording}/finished`);
  updateRecordingTouchbar(false, false);
});

ipcMain.on('will-stop-recording', () => {
  recording = false;
  preparingToRecord = false;
  updateRecordingTouchbar(false, true);
  if (cropperWindow) {
    closeCropperWindow();
  }
});

ipcMain.on('hide-window', event => {
  const window = BrowserWindow.fromWebContents(event.sender);
  window.hide();
});

ipcMain.on('close-window', event => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === prefsWindow && !mainWindowIsDetached) {
    app.dock.hide(); // TODO：Mac专用
  }
  window.close();
});

ipcMain.on('minimize-window', event => {
  BrowserWindow.fromWebContents(event.sender).minimize();
});

ipcMain.on('move-cropper-window', (event, data) => {
  if (!data.direction || !data.amount) {
    return;
  }

  const position = cropperWindow.getPosition();
  const amount = data.amount;

  switch (data.direction) {
    case 'left':
      position[0] -= amount;
      break;
    case 'up':
      position[1] -= amount;
      break;
    case 'right':
      position[0] += amount;
      break;
    case 'down':
      position[1] += amount;
      break;
    default:
      // Catch occasions where direction is not defined for whatever reason (should never happen).
      break;
  }

  cropperWindow.setPosition(...position);
});

ipcMain.on('open-editor-window', (event, opts) => {
  track('editor/preview/accessed');

  if (editorWindow) {
    return editorWindow.show();
  }

  editorWindow = new BrowserWindow({
    width: 768,
    minWidth: 768,
    height: 480,
    minHeight: 480,
    frame: false,
    vibrancy: 'ultra-dark',
    // The below is: `rgba(0, 0, 0, 0.8)`
    // Convert tool: https://kilianvalkhof.com/2016/css-html/css-hexadecimal-colors-with-transparency-a-conversion-tool/
    backgroundColor: '#000000CC'
  });

  app.kap.editorWindow = editorWindow;

  editorWindow.loadURL(`file://${__dirname}/../renderer/views/editor.html`);
  editorWindow.setTouchBar(editorTouchbar(playing));

  editorWindow.webContents.on('did-finish-load', () => editorWindow.webContents.send('video-src', opts.filePath));

  editorWindow.kap = {
    videoFilePath: opts.filePath
  };

  editorWindow.on('closed', () => {
    editorWindow = undefined;
    app.kap.editorWindow = undefined;
    mainWindow.setTouchBar(mainTouchbar);
  });

  ipcMain.on('toggle-fullscreen-editor-window', () => {
    if (!editorWindow) {
      return;
    }
    if (editorWindow.isFullScreen()) {
      editorWindow.setFullScreen(false);
    } else {
      editorWindow.setFullScreen(true);
    }
  });

  menubar.setOption('hidden', true);
  mainWindow.hide();
  tray.setHighlightMode('never');
  app.dock.show(); // TODO：所有dock的地方都是Mac专用
});

ipcMain.on('close-editor-window', () => {
  if (!editorWindow) {
    return;
  }

  dialog.showMessageBox(editorWindow, {
    type: 'question',
    buttons: ['Discard', 'Cancel'],
    defaultId: 1,
    message: 'Are you sure that you want to discard this recording?',
    detail: 'You will no longer be able to edit and export the original recording.'
  }, buttonIndex => {
    if (buttonIndex === 0) {
      discardVideo();
    }
  });
});

ipcMain.on('export', (event, data) => {
  mainWindow.webContents.send('export', data);
});

ipcMain.on('set-main-window-visibility', (event, opts) => {
  if (opts.alwaysOnTop === true && opts.temporary === true && opts.forHowLong) {
    menubar.setOption('alwaysOnTop', true);

    setTimeout(() => {
      menubar.setOption('alwaysOnTop', false);
      tray.setHighlightMode('never');
      if (mainWindowIsDetached === false) {
        mainWindow.hide();
      }
    }, opts.forHowLong);
  }
});

const loadPlugins = async () => {
  if (prefsWindow) {
    prefsWindow.webContents.send('load-plugins', {
      available: await plugins.getFromNpm(),
      installed: plugins.all()
    });
  }
};

const notify = text => {
  (new Notification({
    // The `title` is required for macOS 10.12
    // TODO: Remove when macOS 10.13 is the target
    title: app.getName(), // TODO：Windows下要测试一下
    body: text
  })).show();
};

ipcMain.on('install-plugin', async (event, name) => {
  try {
    await plugins.install(name);
    notify(`Successfully installed plugin ${name}`);
    loadPlugins();
  } catch (err) {
    dialog.showErrorBox(`Failed to install plugin ${name}`, err.stderr || err.stdout || err.stack);
  }
});

ipcMain.on('uninstall-plugin', async (event, name) => {
  try {
    await plugins.uninstall(name);
    loadPlugins();
  } catch (err) {
    dialog.showErrorBox(`Failed to uninstall plugin ${name}`, err.stderr || err.stdout || err.stack);
  }
});

ipcMain.on('toggle-play', (event, status) => {
  if (playing !== status) {
    playing = status;
    editorWindow.setTouchBar(editorTouchbar(status));
  }
});
