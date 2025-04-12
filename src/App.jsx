import React, { useState } from 'react';
import { WebDFU } from 'dfu';
import firmwareUrl from '/assets/firmware/uCritAir-Firmware-latest.bin?url';

function App() {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Ready to update firmware');
  const [isUploading, setIsUploading] = useState(false);
  const [log, setLog] = useState([]);

  // Helper to add log entries
  const addLog = (message) => {
    console.log(message);
    setLog((prev) => [...prev, message]);
  };

  const handleFirmwareUpload = async () => {
    setIsUploading(true);
    setStatus('Connecting to device...');
    setProgress(0);
    setLog([]);

    let webdfu = null;

    try {
      // Step 1: Connect to the device
      addLog('Requesting USB device access...');
      const selectedDevice = await navigator.usb.requestDevice({
        filters: [{ vendorId: 0x2fe3 }],
      });

      addLog(
        `Connected to device: ${selectedDevice.productName || 'Unknown device'}`
      );

      // Initialize WebDFU
      webdfu = new WebDFU(selectedDevice, {
        forceInterfacesName: true,
      });

      await webdfu.init();
      addLog('Device initialized successfully');

      if (!webdfu.interfaces.length) {
        throw new Error('No interfaces found on the selected device.');
      }

      // Find best DFU interface to use
      const bestInterface = findBestDfuInterface(webdfu);
      addLog(
        `Using interface: ${bestInterface.index} (${
          bestInterface.name || 'Unnamed'
        })`
      );

      // Connect to the interface
      await webdfu.connect(bestInterface.index);
      addLog('Connected to DFU interface');

      // Log device capabilities
      const capabilities = {
        DFUVersion: webdfu.properties?.DFUVersion?.toString(16) || 'Unknown',
        CanUpload: webdfu.properties?.CanUpload || false,
        CanDownload: webdfu.properties?.CanDownload || false,
        TransferSize: webdfu.properties?.TransferSize || 'Unknown',
      };
      addLog(`Device capabilities: ${JSON.stringify(capabilities)}`);

      // Step 2: Fetch the firmware
      setStatus('Fetching firmware...');
      addLog('Fetching firmware from: ' + firmwareUrl);
      const response = await fetch(firmwareUrl);
      if (!response.ok)
        throw new Error(`Failed to fetch firmware: ${response.statusText}`);

      const firmwareData = await response.arrayBuffer();
      const firmware = new Uint8Array(firmwareData);
      const firmwareSize = firmware.length;

      setStatus(`Preparing to upload ${firmwareSize} bytes of firmware...`);
      addLog(`Firmware size: ${firmwareSize} bytes`);

      // Default STM32 flash start address
      const startAddress = 0x08000000;
      addLog(`Using start address: 0x${startAddress.toString(16)}`);

      // Try to erase if supported
      try {
        setStatus('Preparing device memory...');
        if (typeof webdfu.erase === 'function') {
          addLog('Erasing flash memory...');
          await webdfu.erase(startAddress, firmwareSize);
          addLog('Flash memory erased successfully');
        } else {
          addLog(
            'Explicit erase function not available - device may auto-erase'
          );
        }
      } catch (eraseError) {
        addLog(`Flash erase warning: ${eraseError.message}`);
      }

      // Try different upload methods
      try {
        setStatus('Uploading firmware...');

        // Define a progress handler to track upload progress
        const progressHandler = (bytesWritten) => {
          const progressPercentage = Math.round(
            (bytesWritten / firmwareSize) * 100
          );
          setProgress(progressPercentage);
          setStatus(`Uploading firmware... ${progressPercentage}%`);

          // Log at certain intervals
          if (
            progressPercentage % 10 === 0 ||
            progressPercentage === 1 ||
            progressPercentage === 100
          ) {
            addLog(`Upload progress: ${progressPercentage}%`);
          }
        };

        // Override the WebDFU progress method to track progress
        const originalProgress = webdfu.logProgress;
        webdfu.logProgress = progressHandler;

        // Try method 1: Use the built-in upload method (for newer WebDFU versions)
        if (typeof webdfu.upload === 'function') {
          addLog('Using WebDFU upload method');

          // Create a new ArrayBuffer for the firmware data
          const buffer = firmware.buffer.slice(0);

          // Call the upload method with the proper ArrayBuffer
          await webdfu.upload(buffer, {
            dfuseStartAddress: startAddress,
            dfuseUploadSize: firmwareSize,
          });

          addLog('Firmware uploaded successfully with upload method');
        }
        // Try method 2: Try direct flash method if available (newer WebDFU)
        else if (typeof webdfu.flash === 'function') {
          addLog('Using WebDFU flash method');
          await webdfu.flash(firmware.buffer, {
            startAddress: startAddress,
          });
          addLog('Firmware uploaded successfully with flash method');
        }
        // Try method 3: Try dfuseUpload as a last resort
        else if (typeof webdfu.dfuseUpload === 'function') {
          addLog('Using WebDFU dfuseUpload method');
          await webdfu.dfuseUpload(firmware.buffer, {
            dfuseStartAddress: startAddress,
          });
          addLog('Firmware uploaded successfully with dfuseUpload method');
        } else {
          throw new Error('No suitable upload method found in WebDFU');
        }

        // Restore original progress handler
        webdfu.logProgress = originalProgress;
      } catch (uploadError) {
        addLog(`Upload failed: ${uploadError.message}`);
        throw new Error(`Firmware upload failed: ${uploadError.message}`);
      }

      // Get potential errors
      try {
        if (typeof webdfu.getStatus === 'function') {
          const status = await webdfu.getStatus();
          addLog(`Device status: ${JSON.stringify(status)}`);
        }
      } catch (statusError) {
        addLog(`Status check note: ${statusError.message}`);
      }

      setStatus('Firmware update complete! Device will reboot shortly.');
      addLog('Firmware update complete!');

      // Try to reset device
      try {
        if (typeof webdfu.reset === 'function') {
          addLog('Sending device reset command');
          await webdfu.reset();
          addLog('Device reset');
        }
      } catch (resetError) {
        addLog(`Reset note: ${resetError.message}`);
      }
    } catch (error) {
      addLog(`ERROR: ${error.message}`);
      console.error('Firmware update error:', error);
      setStatus(`Update failed: ${error.message}`);
    } finally {
      try {
        if (webdfu && typeof webdfu.close === 'function') {
          addLog('Closing WebDFU connection...');
          await webdfu.close();
          addLog('WebDFU connection closed');
        } else if (webdfu && typeof webdfu.disconnect === 'function') {
          addLog('Disconnecting WebDFU...');
          await webdfu.disconnect();
          addLog('WebDFU disconnected');
        }
      } catch (disconnectError) {
        addLog(`Disconnect note: ${disconnectError.message}`);
      }
      setIsUploading(false);
    }
  };

  // Helper function to find the best DFU interface
  const findBestDfuInterface = (webdfu) => {
    // First try to find a named DFU interface
    const dfuInterfaceIndex = webdfu.interfaces.findIndex(
      (intf) => intf.name && intf.name.toLowerCase().includes('dfu')
    );

    if (dfuInterfaceIndex >= 0) {
      return {
        index: dfuInterfaceIndex,
        name: webdfu.interfaces[dfuInterfaceIndex].name,
      };
    }

    // Check for interface class 0xFE (Application Specific) and subclass 0x01 (DFU)
    const dfuClassIndex = webdfu.interfaces.findIndex(
      (intf) =>
        intf.alternate &&
        intf.alternate.interfaceClass === 254 &&
        intf.alternate.interfaceSubclass === 1
    );

    if (dfuClassIndex >= 0) {
      return {
        index: dfuClassIndex,
        name: 'DFU Interface (Class FE/01)',
      };
    }

    // Otherwise return the first interface
    return {
      index: 0,
      name: webdfu.interfaces[0]?.name,
    };
  };

  return (
    <div className="container mt-4">
      <div className="text-center mb-4">
        <h2>μCritAir Web Firmware Updater</h2>
        <p className="lead">
          One-click firmware update for your μCritAir device
        </p>

        <div className="mb-3">
          <button
            className="btn btn-primary btn-lg"
            onClick={handleFirmwareUpload}
            disabled={isUploading}
          >
            {isUploading ? 'Updating...' : 'Update Firmware'}
          </button>
        </div>

        <div className="progress my-3" style={{ height: '25px' }}>
          <div
            className="progress-bar progress-bar-striped progress-bar-animated"
            role="progressbar"
            style={{ width: `${progress}%` }}
          >
            {progress}%
          </div>
        </div>

        <div className="alert alert-info">
          <strong>Status:</strong> {status}
        </div>
      </div>

      {log.length > 0 && (
        <div className="card mt-3 mb-4">
          <div className="card-header">
            <h5 className="mb-0">Update Log</h5>
          </div>
          <div className="card-body">
            <pre
              className="log-console"
              style={{ maxHeight: '200px', overflow: 'auto' }}
            >
              {log.map((entry, i) => (
                <div key={i} className="log-entry">
                  {entry}
                </div>
              ))}
            </pre>
          </div>
        </div>
      )}

      <footer className="mt-5">
        <h5>Instructions</h5>
        <ol className="text-start">
          <li>Connect your μCritAir device to your computer via USB</li>
          <li>Click the "Update Firmware" button and select your device</li>
          <li>Wait for the firmware update to complete</li>
          <li>Your device will restart automatically with the new firmware</li>
        </ol>

        <h5>Links</h5>
        <ul className="list-unstyled">
          <li>
            <a
              href="https://docs.ucritter.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              μCritAir Documentation
            </a>
          </li>
          <li>
            <a
              href="https://github.com/ucritair/ucritair-firmware"
              target="_blank"
              rel="noopener noreferrer"
            >
              μCritAir Firmware Repository
            </a>
          </li>
        </ul>
      </footer>
    </div>
  );
}

export default App;
