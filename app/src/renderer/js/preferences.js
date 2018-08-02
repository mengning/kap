import {ipcRenderer, remote, shell} from 'electron';
import _ from 'lodash';
import $j from 'jquery/dist/jquery.slim';
// Note: `./` == `/app/dist/renderer/views`, not `js`
import {handleTrafficLightsClicks, $, disposeObservers} from '../js/utils';

const {app, dialog, getCurrentWindow} = remote;
/* Delete for windows platform adjusting
const aperture = require('aperture');
*/

const plugins = remote.require('../main/plugins').default;
const settingsValues = app.kap.settings.getAll();

// Observers that should be disposed when the window unloads
const observersToDispose = [];

document.addEventListener('DOMContentLoaded', async () => {
  // Element definitions
  const allowAnalyticsCheckbox = $('#allow-analytics');
  const audioInputDeviceSelector = $('.js-audio-input-device-selector');
  const chooseSaveDirectoryBtn = $('.js-choose-save');
  const record60fpsCheckbox = $('#record-60fps');
  const header = $('header');
  const highlightClicksCheckbox = $('#highlight-clicks');
  const openOnStartupCheckbox = $('#open-on-startup');
  const saveToDescription = $('.js-save-to-description');
  const showCursorCheckbox = $('#show-cursor');
  const hideDesktopIconsCheckbox = $('#hide-desktop-icons');
  const doNotDisturbCheckbox = $('#do-not-disturb');
  const recordKeyboardShortcutCheckbox = $('#record-keyboard-shortcut');
  const openPluginsFolder = $('.js-open-plugins');
  const electronWindow = getCurrentWindow();

  electronWindow.setSheetOffset(header.offsetHeight);
  handleTrafficLightsClicks();

  // Init the shown settings
  saveToDescription.dataset.fullPath = settingsValues.kapturesDir;
  saveToDescription.setAttribute('title', settingsValues.kapturesDir);
  saveToDescription.innerText = `.../${settingsValues.kapturesDir.split('/').pop()}`;
  openOnStartupCheckbox.checked = settingsValues.openOnStartup;
  allowAnalyticsCheckbox.checked = settingsValues.allowAnalytics;
  showCursorCheckbox.checked = settingsValues.showCursor;
  hideDesktopIconsCheckbox.checked = settingsValues.hideDesktopIcons;
  doNotDisturbCheckbox.checked = settingsValues.doNotDisturb;
  record60fpsCheckbox.checked = settingsValues.record60fps;
  recordKeyboardShortcutCheckbox.checked = settingsValues.recordKeyboardShortcut;

  if (settingsValues.showCursor === false) {
    highlightClicksCheckbox.disabled = true;
  } else {
    highlightClicksCheckbox.checked = settingsValues.highlightClicks;
  }

  /* Delete for windows platform adjusting
  for (const device of await aperture.audioDevices()) {
    const option = document.createElement('option');
    option.value = device.id;
    option.text = device.name;
    audioInputDeviceSelector.add(option);
  }
  */

  audioInputDeviceSelector.value = settingsValues.audioInputDeviceId;

  const tabs = $j('.prefs-nav > a');

  tabs.on('click', event => {
    event.preventDefault();
    tabs.removeClass('is-active');
    $j(event.currentTarget).addClass('is-active');

    const panes = $j('.prefs-sections > section');
    const paneName = $j(event.currentTarget).data('pane');

    panes.addClass('hidden');
    panes.filter(`[data-pane="${paneName}"]`).removeClass('hidden');

    if (paneName === 'plugins') {
      plugins.track();
    }
  });

  const pluginListTemplate = _.template(`
    <% _.forEach(plugins, plugin => { %>
      <div class="preference container">
        <div class="preference-part">
          <div class="preference-content">
            <div class="preference__title">
              <a class="preference__url o-link" href data-url="<%- plugin.homepage || (plugin.links && plugin.links.homepage) %>"><%- plugin.prettyName %></a>
              <span class="preference__note"><%- plugin.version %></span>
            </div>
            <p class="preference__description"><%- plugin.description %></p>
          </div>
          <div class="preference-input">
            <div class="c-toggle">
              <input type="checkbox" class="c-toggle__input install-toggle" id="plugin-toggle-<%- plugin.name %>" data-name="<%- plugin.name %>" <%- installed ? 'checked' : '' %>>
              <label class="c-toggle__label" for="plugin-toggle-<%- plugin.name %>"></label>
            </div>
          </div>
        </div>
      </div>
    <% }); %>
  `);

  const loadInstalledPlugins = installedPlugins => {
    const html = pluginListTemplate({
      plugins: installedPlugins,
      installed: true
    });

    $j('#plugins-installed').html(html);
  };

  const loadAvailablePlugins = availablePlugins => {
    const html = pluginListTemplate({
      plugins: availablePlugins,
      installed: false
    });

    $j('#plugins-available').html(html);
  };

  $j('.plugins-list').on('change', '.install-toggle', event => {
    const el = event.currentTarget;
    const name = el.dataset.name;

    $j('.plugins-list .install-toggle').prop('disabled', true);

    if (el.checked) {
      el.classList.add('loading');
      ipcRenderer.send('install-plugin', name);
      $j(event.currentTarget).parents('li').remove(); // We don't want to wait on `loadAvailablePlugins`
    } else {
      ipcRenderer.send('uninstall-plugin', name);
    }
  });

  ipcRenderer.on('load-plugins', (event, {available, installed}) => {
    loadAvailablePlugins(available);
    loadInstalledPlugins(installed);
  });

  // Open plugin homepage
  $j('.plugins-prefs').on('click', '.preference__url', event => {
    event.preventDefault();
    const url = $j(event.currentTarget).data('url');
    shell.openExternal(url);
  });

  loadInstalledPlugins(plugins.all());
  loadAvailablePlugins(await plugins.getFromNpm());

  chooseSaveDirectoryBtn.addEventListener('click', () => {
    const directories = dialog.showOpenDialog(electronWindow, {properties: ['openDirectory', 'createDirectory']});
    if (directories) {
      app.kap.settings.set('kapturesDir', directories[0]);
      saveToDescription.dataset.fullPath = directories[0];
      saveToDescription.innerText = `.../${directories[0].split('/').pop()}`;
    }
  });

  openPluginsFolder.addEventListener('click', event => {
    event.preventDefault();
    // The `shell.openItem(plugins.cwd);` method doesn't focus Finder
    // See: https://github.com/electron/electron/issues/10477
    // We work around it with:
    shell.openExternal(encodeURI(`file://${plugins.cwd}`));
  });

  openOnStartupCheckbox.addEventListener('change', event => {
    app.kap.settings.set('openOnStartup', event.currentTarget.checked);
    app.setLoginItemSettings({openAtLogin: event.currentTarget.checked});
  });

  allowAnalyticsCheckbox.addEventListener('change', event => {
    app.kap.settings.set('allowAnalytics', event.currentTarget.checked);
  });

  showCursorCheckbox.addEventListener('change', event => {
    app.kap.settings.set('showCursor', event.currentTarget.checked);
    if (event.currentTarget.checked) {
      highlightClicksCheckbox.disabled = false;
      highlightClicksCheckbox.checked = app.kap.settings.get('highlightClicks');
    } else {
      highlightClicksCheckbox.disabled = true;
      highlightClicksCheckbox.checked = false;
      app.kap.settings.set('highlightClicks', highlightClicksCheckbox.checked);
    }
  });

  highlightClicksCheckbox.addEventListener('change', event => {
    app.kap.settings.set('highlightClicks', event.currentTarget.checked);
  });

  hideDesktopIconsCheckbox.addEventListener('change', event => {
    app.kap.settings.set('hideDesktopIcons', event.currentTarget.checked);
  });

  doNotDisturbCheckbox.addEventListener('change', event => {
    app.kap.settings.set('doNotDisturb', event.currentTarget.checked);
  });

  record60fpsCheckbox.addEventListener('change', event => {
    app.kap.settings.set('record60fps', event.currentTarget.checked);
  });

  recordKeyboardShortcutCheckbox.addEventListener('change', event => {
    app.kap.settings.set('recordKeyboardShortcut', event.currentTarget.checked);
  });

  audioInputDeviceSelector.addEventListener('change', event => {
    app.kap.settings.set('audioInputDeviceId', event.currentTarget.value);
  });

  // The `showCursor` setting can be changed via the
  // mouse btn in the main window
  observersToDispose.push(app.kap.settings.observe('showCursor', event => {
    showCursorCheckbox.checked = event.newValue;
    showCursorCheckbox.onchange();
  }));
});

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

window.addEventListener('beforeunload', () => {
  disposeObservers(observersToDispose);
});
