import {remote, ipcRenderer} from 'electron';
import aspectRatio from 'aspectratio';
import moment from 'moment';
// Note: `./` == `/app/dist/renderer/views`, not `js`
import {handleKeyDown, validateNumericInput} from '../js/input-utils';
import {handleTrafficLightsClicks, $, handleActiveButtonGroup, getTimestampAtEvent} from '../js/utils';
import {init as initErrorReporter} from '../../common/reporter';

const {app} = remote;
const plugins = remote.require('../main/plugins').default;
const TRIMMER_STEP = 0.00001;

initErrorReporter();

document.addEventListener('DOMContentLoaded', () => {
  const playBtn = $('.js-play-video');
  const pauseBtn = $('.js-pause-video');
  const maximizeBtn = $('.js-maximize-video');
  const unmaximizeBtn = $('.js-unmaximize-video');
  const muteBtn = $('.js-mute-video');
  const unmuteBtn = $('.js-unmute-video');
  const previewTime = $('.js-video-time');
  const previewTimeTip = $('.js-video-time-tip');
  const inputHeight = $('.input-height');
  const inputWidth = $('.input-width');
  const fps15Btn = $('#fps-15');
  const fpsMaxBtn = $('#fps-max');
  const preview = $('#preview');
  const previewContainer = $('.video-preview');
  const progressBar = $('progress');
  const windowHeader = $('.window-header');
  const trimmerIn = $('#trimmer-in');
  const trimmerOut = $('#trimmer-out');
  const trimLine = $('.timeline-markers');

  const maxFps = app.kap.settings.get('record60fps') ? 60 : 30;
  let fps = 15;

  let lastValidInputWidth;
  let lastValidInputHeight;
  let aspectRatioBaseValues;
  let currentPreviewDuration;

  handleTrafficLightsClicks({hide: true});
  handleActiveButtonGroup({buttonGroup: fps15Btn.parentNode});

  fpsMaxBtn.children[0].innerText = maxFps;

  const pause = () => {
    pauseBtn.classList.add('hidden');
    playBtn.classList.remove('hidden');
    preview.pause();
    ipcRenderer.send('toggle-play', false);
  };

  const play = () => {
    playBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    preview.play();
    ipcRenderer.send('toggle-play', true);
  };

  const getTrimmerValue = trimmerEl => {
    return parseFloat(trimmerEl.value);
  };

  const setTrimmerValue = (trimmerEl, value) => {
    trimmerEl.value = String(value);
  };

  const handleTrimmerInput = inputId => {
    pause();

    const inValue = getTrimmerValue(trimmerIn);
    const outValue = getTrimmerValue(trimmerOut);
    let currentFrame = inValue;

    if (inputId === trimmerOut.id) {
      currentFrame = outValue;
    }

    if (inValue >= outValue) {
      switch (inputId) {
        case trimmerIn.id:
          setTrimmerValue(trimmerOut, inValue + TRIMMER_STEP);
          break;
        case trimmerOut.id:
          setTrimmerValue(trimmerIn, outValue - TRIMMER_STEP);
          break;
        default:
          break;
      }
    }
    preview.currentTime = currentFrame;
  };

  const getTrimmedVideoDuration = () => {
    const inValue = getTrimmerValue(trimmerIn);
    const outValue = getTrimmerValue(trimmerOut);
    currentPreviewDuration = outValue - inValue;
    return currentPreviewDuration;
  };

  const initializeTrimmers = () => {
    trimmerIn.max = String(preview.duration);
    trimmerOut.max = String(preview.duration);
    trimmerOut.value = String(preview.duration);
    setTrimmerValue(trimmerIn, 0);

    trimmerIn.addEventListener('input', () => {
      handleTrimmerInput(trimmerIn.id);
      getTrimmedVideoDuration();
    });
    trimmerOut.addEventListener('input', () => {
      handleTrimmerInput(trimmerOut.id);
      getTrimmedVideoDuration();
    });
    trimmerIn.addEventListener('change', play);
    trimmerOut.addEventListener('change', play);
  };

  const hover = event => {
    if (preview.duration) {
      const timeAtEvent = getTimestampAtEvent(event, preview.duration);
      previewTimeTip.style.left = `${event.pageX}px`;
      previewTimeTip.textContent = `${moment().startOf('day').milliseconds(timeAtEvent * 1000).format('m:ss.SS')} (${moment().startOf('day').milliseconds(currentPreviewDuration * 1000).format('m:ss.SS')})`;
    }
  };

  const skip = event => {
    const timeAtEvent = getTimestampAtEvent(event, preview.duration);

    // Check that the time is between the trimmed timeline
    if (getTrimmerValue(trimmerIn) < timeAtEvent && timeAtEvent < getTrimmerValue(trimmerOut)) {
      preview.currentTime = timeAtEvent;
    }
  };

  const shake = el => {
    el.classList.add('shake');

    el.addEventListener('webkitAnimationEnd', () => {
      el.classList.remove('shake');
    });

    return true;
  };

  preview.addEventListener('canplay', event => {
    aspectRatioBaseValues = [event.currentTarget.videoWidth, event.currentTarget.videoHeight];
    [inputWidth.value, inputHeight.value] = aspectRatioBaseValues;
    [lastValidInputWidth, lastValidInputHeight] = aspectRatioBaseValues;

    currentPreviewDuration = preview.duration;
    progressBar.max = preview.duration;
    setInterval(() => {
      const inValue = getTrimmerValue(trimmerIn);
      const outValue = getTrimmerValue(trimmerOut);
      if (preview.currentTime < inValue || preview.currentTime > outValue) {
        preview.currentTime = inValue;
      }
      progressBar.value = preview.currentTime;
      previewTime.innerText = `${moment().startOf('day').seconds(preview.currentTime).format('m:ss')}`;
    }, 1);

    initializeTrimmers();
  }, {once: true});

  pauseBtn.addEventListener('click', pause);
  playBtn.addEventListener('click', play);
  trimLine.addEventListener('click', skip);
  trimLine.addEventListener('mousemove', hover);

  maximizeBtn.addEventListener('click', event => {
    event.currentTarget.classList.add('hidden');
    unmaximizeBtn.classList.remove('hidden');
    ipcRenderer.send('toggle-fullscreen-editor-window');
    $('body').classList.add('fullscreen');
  });

  unmaximizeBtn.addEventListener('click', event => {
    event.currentTarget.classList.add('hidden');
    maximizeBtn.classList.remove('hidden');
    ipcRenderer.send('toggle-fullscreen-editor-window');
    $('body').classList.remove('fullscreen');
  });

  muteBtn.addEventListener('click', () => {
    unmuteBtn.classList.remove('hidden');
    muteBtn.classList.add('hidden');
    preview.muted = true;
  });

  unmuteBtn.addEventListener('click', () => {
    unmuteBtn.classList.add('hidden');
    muteBtn.classList.remove('hidden');
    preview.muted = false;
  });

  inputWidth.addEventListener('input', event => {
    event.currentTarget.value = validateNumericInput(event.currentTarget, {
      lastValidValue: lastValidInputWidth,
      empty: true,
      max: preview.videoWidth,
      min: 1,
      onInvalid: shake
    });

    const tmp = aspectRatio.resize(...aspectRatioBaseValues, event.currentTarget.value);

    if (tmp[1]) {
      lastValidInputHeight = tmp[1];
      inputHeight.value = tmp[1];
    }

    lastValidInputWidth = event.currentTarget.value || lastValidInputWidth;
  });

  inputWidth.addEventListener('keydown', handleKeyDown);

  inputWidth.addEventListener('blur', event => {
    event.currentTarget.value = event.currentTarget.value || (shake(event.currentTarget) && lastValidInputWidth); // Prevent the input from staying empty
  });

  inputHeight.addEventListener('input', event => {
    event.currentTarget.value = validateNumericInput(event.currentTarget, {
      lastValidValue: lastValidInputHeight,
      empty: true,
      max: preview.videoHeight,
      min: 1,
      onInvalid: shake
    });

    const tmp = aspectRatio.resize(...aspectRatioBaseValues, undefined, event.currentTarget.value);

    if (tmp[0]) {
      lastValidInputWidth = tmp[0];
      inputWidth.value = tmp[0];
    }

    lastValidInputHeight = event.currentTarget.value || lastValidInputHeight;
  });

  inputHeight.addEventListener('keydown', handleKeyDown);

  inputHeight.addEventListener('blur', event => {
    event.currentTarget.value = event.currentTarget.value || (shake(event.currentTarget) && lastValidInputHeight); // Prevent the input from staying empty
  });

  fps15Btn.addEventListener('click', event => {
    event.currentTarget.classList.add('active');
    fpsMaxBtn.classList.remove('active');
    fps = 15;
  });

  fpsMaxBtn.addEventListener('click', event => {
    event.currentTarget.classList.add('active');
    fps15Btn.classList.remove('active');
    fps = maxFps;
  });

  window.addEventListener('keyup', event => {
    if (event.key === 'Escape') {
      if (maximizeBtn.classList.contains('hidden')) {
        // Exit fullscreen
        unmaximizeBtn.onclick();
      } else {
        ipcRenderer.send('close-editor-window');
      }
    }

    if (event.key === ' ') {
      if (playBtn.classList.contains('hidden')) {
        pause();
      } else {
        play();
      }
    }
  });

  const shareServices = plugins.getShareServices();

  const handleFile = (service, format) => {
    console.log(service);
    console.log(format);
    service.run({
      format,
      filePath: preview.src,
      width: inputWidth.value,
      height: inputHeight.value,
      fps,
      loop: true,
      startTime: getTrimmerValue(trimmerIn),
      endTime: getTrimmerValue(trimmerOut)
    });
  };

  const registerExportOptions = () => {
    // Use select elements to get initial list of export formats, even if we won't use the select down the line
    const exportFormats = document.querySelectorAll('.output-format .c-select');

    ipcRenderer.on('toggle-format-buttons', (event, data) => {
      for (const btn of exportFormats) {
        const formatButton = document.querySelector(`.output-format button[data-export-type='${btn.dataset.exportType}']`);
        formatButton.disabled = !data.enabled;
        btn.classList.toggle('is-disabled', !data.enabled);
      }
    });

    for (const formatElement of exportFormats) {
      const format = formatElement.dataset.exportType;
      const dropdown = formatElement.querySelector('select');
      const formatButton = document.querySelector(`.output-format button[data-export-type='${format}']`);

      let i = 0;

      for (const service of shareServices) {
        if (service.formats.includes(format)) {
          const option = document.createElement('option');
          option.text = service.title;
          option.value = i;
          dropdown.appendChild(option);
        }

        i++;
      }

      formatElement.appendChild(dropdown);

      // If there are more than the label and default export format, show the select
      // Else show a button instead of a dropdown that handles only "save to file"
      if (dropdown.children.length > 2) {
        // Prevent the dropdown from triggering the button
        dropdown.addEventListener('click', event => {
          event.stopPropagation();
        });

        dropdown.addEventListener('change', () => {
          const service = shareServices[dropdown.value];
          handleFile(service, format);
          dropdown.value = '-1';
        });
      } else {
        const service = shareServices[0];
        formatElement.classList.add('hidden');
        formatButton.classList.remove('hidden');

        formatButton.addEventListener('click', () => handleFile(service, format));
      }
    }
  };

  registerExportOptions();

  ipcRenderer.on('run-plugin', (e, pluginName, format) => {
    const service = shareServices.find(service => service.pluginName === pluginName);
    handleFile(service, format);
  });

  ipcRenderer.on('video-src', (event, src) => {
    preview.src = src;
  });

  ipcRenderer.on('toggle-play', (event, status) => {
    if (status) {
      play();
      return;
    }

    pause();
  });

  previewContainer.addEventListener('mouseover', () => {
    windowHeader.classList.remove('is-hidden');
  });

  previewContainer.addEventListener('mouseout', event => {
    if (!Array.from(windowHeader.querySelectorAll('*')).includes(event.relatedTarget)) {
      windowHeader.classList.add('is-hidden');
    }
  });
});

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());
