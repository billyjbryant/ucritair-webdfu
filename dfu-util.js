var device = null;
(function () {
  'use strict';

  // Global variables for application
  let firmwareFile = null;
  let transferSize = 1024;
  let manifestationTolerant = true;
  const MAX_RETRIES = 3; // Maximum retry attempts for failed operations

  function hex4(n) {
    let s = n.toString(16);
    while (s.length < 4) {
      s = '0' + s;
    }
    return s;
  }

  function hexAddr8(n) {
    let s = n.toString(16);
    while (s.length < 8) {
      s = '0' + s;
    }
    return '0x' + s;
  }

  function niceSize(n) {
    const gigabyte = 1024 * 1024 * 1024;
    const megabyte = 1024 * 1024;
    const kilobyte = 1024;
    if (n >= gigabyte) {
      return n / gigabyte + 'GiB';
    } else if (n >= megabyte) {
      return n / megabyte + 'MiB';
    } else if (n >= kilobyte) {
      return n / kilobyte + 'KiB';
    } else {
      return n + 'B';
    }
  }

  function formatDFUSummary(device) {
    const vid = hex4(device.device_.vendorId);
    const pid = hex4(device.device_.productId);
    const name = device.device_.productName;

    let mode = 'Unknown';
    if (device.settings.alternate.interfaceProtocol == 0x01) {
      mode = 'Runtime';
    } else if (device.settings.alternate.interfaceProtocol == 0x02) {
      mode = 'DFU';
    }

    const cfg = device.settings.configuration.configurationValue;
    const intf = device.settings['interface'].interfaceNumber;
    const alt = device.settings.alternate.alternateSetting;
    const serial = device.device_.serialNumber;
    let info = `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
    return info;
  }

  function formatDFUInterfaceAlternate(settings) {
    let mode = 'Unknown';
    if (settings.alternate.interfaceProtocol == 0x01) {
      mode = 'Runtime';
    } else if (settings.alternate.interfaceProtocol == 0x02) {
      mode = 'DFU';
    }

    const cfg = settings.configuration.configurationValue;
    const intf = settings['interface'].interfaceNumber;
    const alt = settings.alternate.alternateSetting;
    const name = settings.name ? settings.name : 'UNKNOWN';

    return `${mode}: cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}"`;
  }

  async function fixInterfaceNames(device_, interfaces) {
    // Check if any interface names were not read correctly
    if (interfaces.some((intf) => intf.name == null)) {
      // Manually retrieve the interface name string descriptors
      let tempDevice = new dfu.Device(device_, interfaces[0]);
      await tempDevice.device_.open();
      await tempDevice.device_.selectConfiguration(1);
      let mapping = await tempDevice.readInterfaceNames();
      await tempDevice.close();

      for (let intf of interfaces) {
        if (intf.name === null) {
          let configIndex = intf.configuration.configurationValue;
          let intfNumber = intf['interface'].interfaceNumber;
          let alt = intf.alternate.alternateSetting;
          intf.name = mapping[configIndex][intfNumber][alt];
        }
      }
    }
  }

  function populateInterfaceList(form, device_, interfaces) {
    let old_choices = Array.from(form.getElementsByTagName('div'));
    for (let radio_div of old_choices) {
      form.removeChild(radio_div);
    }

    let button = form.getElementsByTagName('button')[0];

    for (let i = 0; i < interfaces.length; i++) {
      let radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'interfaceIndex';
      radio.value = i;
      radio.id = 'interface' + i;
      radio.required = true;

      let label = document.createElement('label');
      label.textContent = formatDFUInterfaceAlternate(interfaces[i]);
      label.className = 'radio';
      label.setAttribute('for', 'interface' + i);

      let div = document.createElement('div');
      div.appendChild(radio);
      div.appendChild(label);
      form.insertBefore(div, button);
    }
  }

  function getDFUDescriptorProperties(device) {
    // Attempt to read the DFU functional descriptor
    // TODO: read the selected configuration's descriptor
    return device.readConfigurationDescriptor(0).then(
      (data) => {
        let configDesc = dfu.parseConfigurationDescriptor(data);
        let funcDesc = null;
        let configValue = device.settings.configuration.configurationValue;
        if (configDesc.bConfigurationValue == configValue) {
          for (let desc of configDesc.descriptors) {
            if (
              desc.bDescriptorType == 0x21 &&
              desc.hasOwnProperty('bcdDFUVersion')
            ) {
              funcDesc = desc;
              break;
            }
          }
        }

        if (funcDesc) {
          return {
            WillDetach: (funcDesc.bmAttributes & 0x08) != 0,
            ManifestationTolerant: (funcDesc.bmAttributes & 0x04) != 0,
            CanUpload: (funcDesc.bmAttributes & 0x02) != 0,
            CanDnload: (funcDesc.bmAttributes & 0x01) != 0,
            TransferSize: funcDesc.wTransferSize,
            DetachTimeOut: funcDesc.wDetachTimeOut,
            DFUVersion: funcDesc.bcdDFUVersion,
          };
        } else {
          return {};
        }
      },
      (error) => {}
    );
  }

  // Current log div element to append to
  let logContext = null;

  function setLogContext(div) {
    logContext = div;
  }

  function clearLog(context) {
    if (typeof context === 'undefined') {
      context = logContext;
    }
    if (context) {
      context.innerHTML = '';
    }
  }

  function logDebug(msg) {
    console.log(msg);
  }

  function logInfo(msg) {
    if (logContext) {
      let info = document.createElement('p');
      info.className = 'info';
      info.textContent = msg;
      logContext.appendChild(info);
    }
  }

  function logWarning(msg) {
    if (logContext) {
      let warning = document.createElement('p');
      warning.className = 'warning';
      warning.textContent = msg;
      logContext.appendChild(warning);
    }
  }

  function logError(msg) {
    if (logContext) {
      let error = document.createElement('p');
      error.className = 'error';
      error.textContent = msg;
      logContext.appendChild(error);
    }
  }

  function logProgress(done, total) {
    if (logContext) {
      let progressBar;
      if (logContext.lastChild.tagName.toLowerCase() == 'progress') {
        progressBar = logContext.lastChild;
      }
      if (!progressBar) {
        progressBar = document.createElement('progress');
        logContext.appendChild(progressBar);
      }
      progressBar.value = done;
      if (typeof total !== 'undefined') {
        progressBar.max = total;
      }
    }
  }

  function onDisconnect(reason) {
    const statusDisplay = document.querySelector('#status-display');
    const connectBtn = document.querySelector('#connect-btn');
    const deviceInfo = document.querySelector('#device-info');
    const updateBtn = document.querySelector('#update-btn');

    if (reason) {
      statusDisplay.textContent = reason;
    }

    connectBtn.textContent = 'Connect Device';
    deviceInfo.innerHTML = '';
    updateBtn.disabled = true;
  }

  function onUnexpectedDisconnect(event) {
    if (device !== null && device.device_ !== null) {
      if (device.device_ === event.device) {
        device.disconnected = true;
        onDisconnect('Device disconnected unexpectedly');
        device = null;
      }
    }
  }

  function getStatusDescription(status) {
    // Helper function to provide human-readable error descriptions
    switch (status) {
      case 0x00:
        return 'No error';
      case 0x01:
        return 'Target error';
      case 0x02:
        return 'File error';
      case 0x03:
        return 'Write error';
      case 0x04:
        return 'Erase error';
      case 0x05:
        return 'Check erased error';
      case 0x06:
        return 'Programming error';
      case 0x07:
        return 'Verify error';
      case 0x08:
        return 'Address error';
      case 0x09:
        return 'Not done error';
      case 0x0a:
        return 'Firmware error';
      case 0x0b:
        return 'Vendor error';
      case 0x0c:
        return 'USB error';
      case 0x0d:
        return 'POR error';
      case 0x0e:
        return 'Unknown error';
      case 0x0f:
        return 'Stalled packet error (try resetting device)';
      default:
        return 'Unknown error code';
    }
  }

  async function resetDevice(dev) {
    // Try to reset the device to recover from errors
    try {
      await dev.abortToIdle();
      logInfo('Device reset successful');
      return true;
    } catch (error) {
      logWarning('Device reset failed: ' + error);
      return false;
    }
  }

  async function connect(device) {
    const statusDisplay = document.querySelector('#status-display');
    const connectBtn = document.querySelector('#connect-btn');
    const deviceInfo = document.querySelector('#device-info');
    const updateBtn = document.querySelector('#update-btn');

    try {
      await device.open();
    } catch (error) {
      onDisconnect(error);
      throw error;
    }

    // Attempt to parse the DFU functional descriptor
    let desc = {};
    try {
      desc = await getDFUDescriptorProperties(device);
    } catch (error) {
      onDisconnect(error);
      throw error;
    }

    let memorySummary = '';
    if (desc && Object.keys(desc).length > 0) {
      device.properties = desc;
      let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${
        desc.ManifestationTolerant
      }, CanUpload=${desc.CanUpload}, CanDnload=${
        desc.CanDnload
      }, TransferSize=${desc.TransferSize}, DetachTimeOut=${
        desc.DetachTimeOut
      }, Version=${hex4(desc.DFUVersion)}`;
      deviceInfo.textContent += '\n' + info;
      transferSize = desc.TransferSize || 1024;
      if (desc.CanDnload) {
        manifestationTolerant = desc.ManifestationTolerant;
      }

      if (
        desc.DFUVersion == 0x011a &&
        device.settings.alternate.interfaceProtocol == 0x02
      ) {
        device = new dfuse.Device(device.device_, device.settings);
        if (device.memoryInfo) {
          let totalSize = 0;
          for (let segment of device.memoryInfo.segments) {
            totalSize += segment.end - segment.start;
          }
          memorySummary = `Selected memory region: ${
            device.memoryInfo.name
          } (${niceSize(totalSize)})`;
          for (let segment of device.memoryInfo.segments) {
            let properties = [];
            if (segment.readable) {
              properties.push('readable');
            }
            if (segment.erasable) {
              properties.push('erasable');
            }
            if (segment.writable) {
              properties.push('writable');
            }
            let propertySummary = properties.join(', ');
            if (!propertySummary) {
              propertySummary = 'inaccessible';
            }

            memorySummary += `\n${hexAddr8(segment.start)}-${hexAddr8(
              segment.end - 1
            )} (${propertySummary})`;
          }
        }
      }
    }

    // Bind logging methods
    device.logDebug = logDebug;
    device.logInfo = logInfo;
    device.logWarning = logWarning;
    device.logError = logError;
    device.logProgress = logProgress;

    // Clear logs
    clearLog(document.querySelector('#download-log'));

    // Display basic USB information
    statusDisplay.textContent = 'Connected to device';
    connectBtn.textContent = 'Disconnect';
    deviceInfo.innerHTML =
      'Name: ' +
      device.device_.productName +
      '<br>' +
      'MFG: ' +
      device.device_.manufacturerName +
      '<br>' +
      'Serial: ' +
      device.device_.serialNumber +
      '<br>';

    // Display firmware version if available
    const firmwareVersionMatch =
      device.device_.productName.match(/v(\d+(\.\d+)*)/);
    if (firmwareVersionMatch) {
      deviceInfo.innerHTML +=
        '<br>Firmware version: ' + firmwareVersionMatch[0];
    }

    // Display basic dfu-util style info
    deviceInfo.innerHTML +=
      '<br>' + formatDFUSummary(device) + '<br>' + memorySummary;

    // Update buttons based on capabilities
    updateBtn.disabled = false;

    return device;
  }

  async function handleConnectClick() {
    const statusDisplay = document.querySelector('#status-display');
    const connectBtn = document.querySelector('#connect-btn');

    if (device) {
      try {
        await device.close();
        device = null;
        connectBtn.textContent = 'Connect Device';
        statusDisplay.textContent = 'Device disconnected';
        document.querySelector('#device-info').innerHTML = '';
        document.querySelector('#update-btn').disabled = true;
        return;
      } catch (error) {
        statusDisplay.textContent = 'Error disconnecting: ' + error;
        return;
      }
    }

    try {
      statusDisplay.textContent = 'Select your μCritAir device...';
      const selectedDevice = await navigator.usb.requestDevice({
        filters: [{ vendorId: 0x2fe3 }], // μCritAir vendor ID
      });

      const interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
      if (interfaces.length === 0) {
        statusDisplay.textContent =
          'No DFU interfaces found on selected device.';
        return;
      }

      await fixInterfaceNames(selectedDevice, interfaces);

      if (interfaces.length === 1) {
        // Single interface
        device = new dfu.Device(selectedDevice, interfaces[0]);
        await connect(device);
      } else {
        // Multiple interfaces - show dialog
        const interfaceDialog = document.querySelector('#interfaceDialog');
        const interfaceForm = document.querySelector('#interfaceForm');

        populateInterfaceList(interfaceForm, selectedDevice, interfaces);

        // Setup form submit handler
        const submitHandler = async function (event) {
          event.preventDefault();
          interfaceForm.removeEventListener('submit', submitHandler);

          const index = interfaceForm.elements['interfaceIndex'].value;
          device = new dfu.Device(selectedDevice, interfaces[index]);

          interfaceDialog.close();
          await connect(device);
        };

        interfaceForm.addEventListener('submit', submitHandler);

        // Show the dialog
        interfaceDialog.showModal();
      }
    } catch (error) {
      statusDisplay.textContent = 'Error connecting: ' + error;
    }
  }

  async function handleUpdateClick() {
    const statusDisplay = document.querySelector('#status-display');
    const downloadLog = document.querySelector('#download-log');

    if (!device) {
      statusDisplay.textContent = 'Please connect a device first';
      return;
    }

    if (!firmwareFile) {
      statusDisplay.textContent = 'Firmware file not loaded';
      return;
    }

    try {
      setLogContext(downloadLog);
      clearLog(downloadLog);
      statusDisplay.textContent = 'Updating firmware...';

      // Clear any error status
      try {
        let status = await device.getStatus();
        if (status.state == dfu.dfuERROR) {
          await device.clearStatus();
        }
      } catch (error) {
        device.logWarning('Failed to clear status: ' + error);
      }

      // Add a small delay before starting the update
      logInfo('Preparing for firmware update...');
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Adjust transfer size for μCritAir devices to improve reliability
      if (
        device.device_.productName.includes('MCUBOOT') ||
        device.device_.manufacturerName.includes('ZEPHYR')
      ) {
        // μCritAir devices work better with smaller transfer sizes
        transferSize = Math.min(transferSize, 512);
        logInfo(`Using optimized transfer size: ${transferSize} bytes`);
      }

      // Perform the update with retry capability
      let attempts = 0;
      let success = false;

      while (attempts < MAX_RETRIES && !success) {
        try {
          if (attempts > 0) {
            logInfo(`Retry attempt ${attempts}/${MAX_RETRIES}...`);
            await resetDevice(device);
            await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait before retry
          }

          await device.do_download(
            transferSize,
            firmwareFile,
            manifestationTolerant
          );

          success = true;
        } catch (error) {
          attempts++;

          // If we've hit max retries or it's not a recoverable error, fail
          if (
            attempts >= MAX_RETRIES ||
            (!error.toString().includes('status=15') &&
              !error.toString().includes('stalled'))
          ) {
            throw error;
          }

          logWarning(`Update failed: ${error}`);
          logInfo('Will retry in a moment...');
        }
      }

      logInfo('Update complete!');
      statusDisplay.textContent = 'Firmware updated successfully!';
      setLogContext(null);

      if (!manifestationTolerant) {
        device.waitDisconnected(5000).then(
          (dev) => {
            onDisconnect('Device disconnected after update');
            device = null;
          },
          (error) => {
            console.log('Device remained connected after update');
          }
        );
      }
    } catch (error) {
      logError(error);

      // Provide more helpful error messages for common issues
      if (error.toString().includes('status=15')) {
        logInfo(
          'This error (status 15) often occurs due to timing issues or incompatible transfer sizes.'
        );
        logInfo('Try the following:');
        logInfo('1. Disconnect and reconnect your device');
        logInfo('2. If available, put your device in bootloader mode manually');
        logInfo('3. Try using a different USB port or cable');
      }

      statusDisplay.textContent = 'Update failed: ' + error;
      setLogContext(null);
    }
  }

  document.addEventListener('DOMContentLoaded', (event) => {
    // Load firmware from file
    fetch('./public/uCritAir-Eclipse-v74.signed.bin')
      .then((response) => response.blob())
      .then((blob) => {
        const reader = new FileReader();
        reader.onload = function () {
          firmwareFile = reader.result;
          document.querySelector('#status-display').textContent =
            'Firmware loaded. Connect a device to update.';
        };
        reader.onerror = function () {
          document.querySelector('#status-display').textContent =
            'Failed to load firmware file.';
        };
        reader.readAsArrayBuffer(blob);
      })
      .catch((error) => {
        document.querySelector('#status-display').textContent =
          'Failed to load firmware file: ' + error;
      });

    // Setup UI elements
    const connectButton = document.querySelector('#connect-btn');
    const updateButton = document.querySelector('#update-btn');
    const statusDisplay = document.querySelector('#status-display');
    const interfaceDialog = document.querySelector('#interfaceDialog');

    // Add event listeners
    connectButton.addEventListener('click', handleConnectClick);
    updateButton.addEventListener('click', handleUpdateClick);

    // Check WebUSB availability
    if (typeof navigator.usb !== 'undefined') {
      navigator.usb.addEventListener('disconnect', onUnexpectedDisconnect);
      statusDisplay.textContent = 'Ready. Please connect your device.';
    } else {
      statusDisplay.textContent =
        'WebUSB not available. Please use Chrome or Edge.';
      connectButton.disabled = true;
      updateButton.disabled = true;
    }
  });

  // Make functions available to the global scope
  window.setLogContext = setLogContext;
  window.clearLog = clearLog;
  window.handleConnectClick = handleConnectClick;
  window.handleUpdateClick = handleUpdateClick;
  window.fixInterfaceNames = fixInterfaceNames;
  window.populateInterfaceList = populateInterfaceList;
})();
