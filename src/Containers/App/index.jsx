import UAParser from 'ua-parser-js';
import TagManager from 'react-gtm-module';
import React, { Component } from 'react';
import Rtttl from 'bluejay-rtttl-parse';
import dateFormat from 'dateformat';
import i18next from 'i18next';
import BinToHex from 'bin-to-hex';

import { fetchHexCached } from '../../utils/Fetch';
import { TimeoutError } from '../../utils/helpers/QueueProcessor';
import { getMasterSettings } from '../../utils/helpers/Settings';
import {
  delay,
  getAppSetting,
} from '../../utils/helpers/General';
import MainApp from '../../Components/App';
import Serial from '../../utils/Serial';
import sources from '../../sources';
import {
  clearLog,
  loadLog,
  loadSerialApi,
} from '../../utils/LocalStorage';
import { MessageNotOkError } from '../../utils/Errors';

import { store } from '../../store';
import { updateAll as updatatAllMelodies } from '../../Components/MelodyEditor/melodiesSlice';

class App extends Component {
  constructor() {
    super();

    this.log = loadLog();
    this.serialApi = loadSerialApi();

    this.gtmActive = false;
    this.serial = undefined;
    this.lastConnected = 0;

    this.state = {
      msp: { features: {} },
      escs: {
        connected: 0,
        master: {},
        targets: [],
        individual: [],
      },
      serial: {
        availablePorts: [],
        baudRate: 115200,
        checked: false,
        chosenPort: null,
        connected: false,
        fourWay: false,
        hasSerial: false,
        log: [],
        open: false,
        portNames: [],
      },
      configs: {
        versions: {},
        escs: {},
        pwm: {},
        getPwm: {},
      },
      actions: {
        isReading: false,
        isWriting: false,
        isSelecting: false,
        isFlashing: false,
        isConnecting: false,
        isDisconnecting: false,
      },
    };

    // Redefine the console and tee logs
    window.console.debug = (text, ...args) => {
      const msg = [text, args.join(' ')].join(' ');
      this.updateLog(msg);

      if(getAppSetting('printLogs')) {
        console.log(text, ...args);
      }
    };
  }

  async componentDidMount() {
    this.onMount(async() => {

      const uaParser = new UAParser();
      const browser = uaParser.getBrowser();
      const os = uaParser.getOS();
      this.addLogMessage('browser', {
        ...browser,
        os: os.name,
      });

      if (this.serialApi) {
        /**
         * Fetch configs in the background - some of them are fetched via
         * github API and might take some time to be fetched.
         */
        this.fetchConfigs().then((configs) => this.setState({ configs }));

        this.serialApi.removeEventListener('connect', this.serialConnectHandler);
        this.serialApi.removeEventListener('disconnect', this.serialDisconnectHandler);

        this.serialApi.addEventListener('connect', this.serialConnectHandler);
        this.serialApi.addEventListener('disconnect', this.serialDisconnectHandler);
        this.serialConnectHandler();
      } else {
        this.setSerial({ checked: true });
      }
    });
  }

  shouldComponentUpdate() {
    return true;
  }

  onMount(cb){
    cb();
  }

  setSerial = (settings) => {
    const { serial } = this.state;
    this.setState({
      serial: {
        ...serial,
        ...settings,
      },
    });
  };

  setEscs = (settings, cb = null) => {
    const { escs } = this.state;
    this.setState({
      escs: {
        ...escs,
        ...settings,
      },
    }, cb);
  };

  setActions = (settings) => {
    const { actions } = this.state;
    this.setState({
      actions: {
        ...actions,
        ...settings,
      },
    });
  };

  updateLog = (message) => {
    const now = dateFormat(new Date(), 'yyyy/mm/dd HH:MM:ss');
    this.log.push(`${now}: ${message}`);
    localStorage.setItem('log', JSON.stringify(this.log));
  };

  addLogMessage = async(message, params = {}) => {
    const { serial } = this.state;
    const translation = i18next.t(`log:${message}`, params);

    params.lng = 'en';
    const translationEn = i18next.t(`log:${message}`, params);
    this.updateLog(translationEn);

    if(getAppSetting('printLogs')) {
      console.log(translationEn);
    }

    const log = [ ...serial.log ];
    log.push(this.formatLogMessage(translation));
    this.setSerial({ log });
  };

  fetchConfigs = async() => {
    const { configs } = this.state;
    for(let i = 0; i < sources.length; i += 1) {
      const source = sources[i];
      const name = source.getName();

      source.setSkipCache(getAppSetting('skipCache'));

      try {
        configs.versions[name] = await source.getVersions();
        configs.escs[name] = source.getEscLayouts();
        configs.getPwm[name] = (version) => source.getPwm(version);
      } catch(e) {
        this.addLogMessage('fetchingFilesFailed', { name: name });

        configs.versions[name] = [];
        configs.escs[name] = [];
        configs.getPwm[name] = null;
      }
    }

    return configs;
  };

  formatLogMessage = (html) => {
    const now = new Date();
    const formattedDate = dateFormat(now, 'yyyy-mm-dd @ ');
    const formattedTime = dateFormat(now, 'HH:MM:ss -- ');

    return (
      <div>
        <span className="date">
          {formattedDate}
        </span>

        <span className="time">
          {formattedTime}
        </span>

        {html}
      </div>
    );
  };

  flash = async(text, force, migrate) => {
    const { escs } = this.state;
    const individual = [ ...escs.individual ];

    for(let i = 0; i < escs.targets.length; i += 1) {
      const target = escs.targets[i];
      const esc = escs.individual.find((esc) => esc.index === target);

      // this will throw a exception when preflight fails
      await this.serial.flashPreflight(esc, text, force);

      const updateProgress = async(percent) => {
        if(esc.ref && esc.ref.current) {
          esc.ref.current.setProgress((percent));
        }
      };

      this.addLogMessage('flashingEsc', { index: target + 1 });
      const result = await this.serial.writeHex(target, esc, text, force, migrate, updateProgress);
      updateProgress(0);

      if(result) {
        result.index = target;
        result.ref = React.createRef();
        const individualIndex = escs.individual.findIndex((esc) => esc.index === target);
        individual[individualIndex] = result;

        await this.setEscs({ individual });
      } else {
        this.addLogMessage('flashingEscFailed', { index: target + 1 });
      }
    }

    this.setEscs({ master: getMasterSettings(individual) });
    this.setActions({ isFlashing: false });
  };

  serialConnectHandler = async() => {
    let connected = false;
    this.serial = undefined;

    const ports = await this.serialApi.getPorts();
    if(ports.length > 0) {
      TagManager.dataLayer({ dataLayer: { event: "Plugged in" } });
      this.addLogMessage('pluggedIn');
      connected = true;

      // Set the first  serial port as the active one
      this.serial = new Serial(ports[0]);
    }

    const portNames = ports.map((item) => {
      const info = item.getInfo();
      const name = `${info.usbVendorId}:${info.usbProductId}`;

      return name;
    });

    this.setSerial({
      availablePorts: ports,
      checked: true,
      connected: connected,
      fourWay: false,
      hasSerial: true,
      portNames: portNames,
    });
  };

  serialDisconnectHandler = async() => {
    TagManager.dataLayer({ dataLayer: { event: "Unplugged" } });
    this.addLogMessage('unplugged');
    this.lastConnected = 0;

    const availablePorts = await this.serialApi.getPorts();
    const portNames = availablePorts.map((item) => {
      const info = item.getInfo();
      const name = `${info.usbVendorId}:${info.usbProductId}`;

      return name;
    });

    this.serial.disconnect();

    this.setSerial({
      availablePorts,
      chosenPort: null,
      connected: availablePorts.length > 0 ? true : false,
      fourWay: false,
      open: false,
      portNames,
    });

    this.setEscs({ individual: [] });
  };

  handleSaveLog = () => {
    const element = document.createElement("a");
    const file = new Blob([this.log.join("\n")], { type: 'text/plain' });
    element.href = URL.createObjectURL(file);
    element.download = "esc-configurator-log.txt";
    document.body.appendChild(element);
    element.click();

    this.handleClearLog();
  };

  handleClearLog = () => {
    this.log = clearLog();
  };

  handleSettingsUpdate = (master) => {
    this.setEscs({ master });
  };

  handleIndividualSettingsUpdate = (index, individualSettings) => {
    const  { escs } = this.state;
    const individual = [ ...escs.individual ];
    for(let i = 0; i < individual.length; i += 1) {
      if(individual[i].index === index) {
        individual[i].individualSettings = individualSettings;

        break;
      }
    }

    this.setEscs({ individual });
  };

  handleCommonSettingsUpdate = (index, commonSettings) => {
    const  { escs } = this.state;
    const individual = [ ...escs.individual ];
    for(let i = 0; i < individual.length; i += 1) {
      if(individual[i].index === index) {
        individual[i].settings = commonSettings;

        break;
      }
    }

    this.setEscs({ individual });
  };

  handleResetDefaultls = async() => {
    TagManager.dataLayer({ dataLayer: { event: "Restoring Defaults" } });

    this.setActions({ isWriting: true });
    const { escs } = this.state;
    for(let i = 0; i < escs.individual.length; i += 1) {
      const esc = escs.individual[i];
      const target = esc.index;
      const currentEscSettings = esc.settings;
      const defaultSettings = esc.defaultSettings;
      const mergedSettings = {
        ...currentEscSettings,
        ...defaultSettings,
      };

      try {
        await this.serial.writeSettings(target, esc, mergedSettings);
      } catch(e) {
        this.addLogMessage('restoreSettingsFailed', { index: i + 1 });
        console.debug(e);
      }
    }
    this.setActions({ isWriting: false });

    this.handleReadEscs();
  };

  handleReadEsc = async(target) => {
    const settings = await this.serial.getFourWayInterfaceInfo(target);

    return settings;
  };

  handleReadEscs = async() => {
    const { escs } = this.state;
    const newEscs = { ...escs };
    const individual = [];

    let fourWay = true;
    let connected = 0;

    this.setActions({ isReading: true });

    // Prevent reading if radio is detected to be on and not connected yet
    if(!escs.connected) {
      const status = await this.serial.getStatus();
      if(!status.armingDisableFlagsReasons.RX_FAILSAFE) {
        this.addLogMessage('radioOn');
        this.setActions({ isReading: false });

        return;
      }
    }

    try {
      if(this.lastConnected === 0) {
        const escs = await this.serial.enable4WayInterface();
        connected = escs.connectedESCs;

        await this.serial.startFourWayInterface();

        /* Give the ESCs some time to boot - it might take longer if they
         * are playing a startup melody.
         */
        await delay(1200);
      } else {
        connected = this.lastConnected;
      }
    } catch(e) {
      fourWay = false;

      this.addLogMessage('fourWayFailed');
      console.debug(e);
    }

    this.addLogMessage('readEscs', { connected });

    for (let i = 0; i < connected; i += 1) {
      try {
        const settings = await this.handleReadEsc(i);
        settings.index = i;
        settings.ref = React.createRef();
        individual.push(settings);

        this.addLogMessage('readEsc', {
          index: i + 1,
          name: settings.displayName,
        });
      } catch(e) {
        this.addLogMessage('readEscFailed', { index: i + 1 });
        console.debug(e);
      }
    }

    if(individual.length > 0) {
      TagManager.dataLayer({
        dataLayer: {
          event: "ESCs",
          escs: {
            name: individual[0].displayName,
            layout: individual[0].make,
            count: individual.length,
          },
        },
      });

      if(individual[0].actualMake) {
        TagManager.dataLayer({
          dataLayer: {
            event: "Mistagged",
            mistagged: {
              name: individual[0].displayName,
              tagged: individual[0].make,
              detected: individual[0].actualMake,
            },
          },
        });
      }

      this.addLogMessage('readEscsSuccess');
    }

    this.lastConnected = connected;
    this.setActions({ isReading: false });

    this.setSerial({ fourWay });

    // Set flashed melodies if available
    const master = getMasterSettings(individual);
    if(master && master.STARTUP_MELODY) {
      const melodies = individual.map((esc) => {
        const melody = esc.individualSettings.STARTUP_MELODY;
        return Rtttl.fromBluejayStartupMelody(melody);
      });

      store.dispatch(updatatAllMelodies(melodies));
    }

    this.setEscs({
      ...newEscs,
      connected,
      individual,
      master,
    });
  };

  handleWriteSettings = async() => {
    TagManager.dataLayer({ dataLayer: { event: "Writing Setup" } });

    this.setActions({ isWriting: true });
    const { escs } = this.state;

    const individual = [ ...escs.individual ];
    for(let i = 0; i < individual.length; i += 1) {
      const esc = individual[i];
      const target = esc.index;
      const commonEscSettings = esc.settings;
      const masterEscSettings = escs.master;
      const individualEscSettings = esc.individualSettings;

      let commonOverrides = {};
      if(getAppSetting('disableCommon')) {
        commonOverrides = commonEscSettings;
      }

      const mergedSettings = {
        ...commonEscSettings,
        ...masterEscSettings,
        ...commonOverrides,
        ...individualEscSettings,
      };

      try {
        await this.serial.writeSettings(target, esc, mergedSettings);

        const newInfo = await this.handleReadEsc(target);
        individual[i] = {
          ...individual[i],
          settingsArray: newInfo.settingsArray,
          settings: newInfo.settings,
          displayName: newInfo.displayName,
        };
      } catch(e) {
        this.addLogMessage('writeSettingsFailed', { index: i + 1 });
        console.debug(e);
      }
    }
    this.setActions({ isWriting: false });

    this.setEscs({ individual });
  };

  handleFirmwareDump = async (target) => {
    const { escs } = this.state;
    const esc = escs.individual.find((esc) => esc.index === target);

    const updateProgress = async(percent) => {
      if(esc.ref && esc.ref.current) {
        esc.ref.current.setProgress((percent));
      }
    };

    this.setActions({ isFlashing: true });

    this.addLogMessage('dumpingEsc', { index: target + 1 });
    const dataBin = await this.serial.readFirmware(target, esc, updateProgress);
    const binToHex = new BinToHex(16, 0x00, 0xFF);
    const dataHex = binToHex.convert(dataBin);
    updateProgress(0);

    this.setActions({ isFlashing: false });


    const element = document.createElement("a");
    const file = new Blob([dataHex], { type: 'text/plain' });
    element.href = URL.createObjectURL(file);
    element.download = "dump.hex";
    document.body.appendChild(element);
    element.click();
  };

  handleSingleFlash = (index) => {
    this.setEscs({ targets: [index] });
    this.setActions({ isSelecting: true });
  };

  handleSelectFirmwareForAll = () => {
    const { escs } = this.state;

    const targets = [];
    for (let i = 0; i < escs.individual.length; i += 1) {
      const esc = escs.individual[i];
      targets.push(esc.index);
    }

    this.setActions({ isSelecting: true });
    this.setEscs({ targets });
  };

  handleCancelFirmwareSelection = () => {
    this.setActions({ isSelecting: false });
    this.setEscs({ targets: [] });
  };

  handleLocalSubmit = (e, force, migrate) => {
    e.preventDefault();
    this.setActions({
      isFlashing: true,
      isSelecting: false,
    });

    const { escs } = this.state;

    TagManager.dataLayer({
      dataLayer: {
        event: 'LocalFlash',
        firmware: {
          force,
          count: escs.targets.length,
        },
      },
    });

    const reader = new FileReader();
    reader.onload = async (e) => {
      console.debug('Flashing local file');

      const text = (e.target.result);
      try {
        await this.flash(text, force, migrate);
      } catch(e) {
        console.error(e);
        this.setActions({ isFlashing: false });
      }
    };
    reader.readAsText(e.target.files[0]);
  };

  /**
   * Acquires the hex file from an URL. Before doing so, the local storage is
   * checked if the file already exists there, it is used, otherwise it is
   * downloaded and put into local storage for later use.
   */
  handleFlashUrl = async(url, layout, name, version, pwm, force, migrate) => {
    this.setActions({
      isFlashing: true,
      isSelecting: false,
    });

    const { escs } = this.state;
    console.debug(`Chosen firmware: ${url}`);

    let type = 'remote';
    let text = null;
    try {
      text = await fetchHexCached(url);
    } catch(e) {
      console.debug('Failed fetching firmware');
    }

    if(text) {
      TagManager.dataLayer({
        dataLayer: {
          event: 'RemoteFlash',
          firmware: {
            type,
            layout,
            name,
            version,
            pwm,
            url,
            force,
            count: escs.targets.length,
          },
        },
      });

      await this.flash(text, force, migrate);
    } else {
      this.addLogMessage('getFileFailed');
      this.setActions({ isFlashing: false });
    }
  };

  handleSetPort = async() => {
    try {
      const port = await this.serialApi.requestPort();
      this.serial = new Serial(port);

      this.addLogMessage('portSelected');

      const portNames = [port].map((item) => {
        const info = item.getInfo();
        const name = `${info.usbVendorId}:${info.usbProductId}`;

        return name;
      });

      this.setSerial({
        availablePorts: [port],
        connected: true,
        portNames,
      });
    } catch (e) {
      // No port selected, do nothing
      console.debug(e);
    }
  };

  handleChangePort = (index) => {
    const { serial } = this.state;
    this.serial = new Serial(serial.availablePorts[index]);

    this.addLogMessage('portChanged');
    this.setSerial({ chosenPort: serial.availablePorts[index] });
  };

  handleSetBaudRate = (rate) => {
    this.setSerial({ baudRate: rate });
  };

  handleConnect = async(e) => {
    e.preventDefault();
    const { serial } = this.state;

    this.setActions({ isConnecting: true });

    try {
      await this.serial.open(serial.baudRate);
      this.serial.setLogCallback(this.addLogMessage);
      this.addLogMessage('portOpened');

      /* Send a reset of the 4 way interface, just in case it was not cleanly
       * disconnected before.
       *
       * Unfortunately this convenience feature can not be used, since on EMU
       * it might lead to the ESCs being wiped.
       */
      // await this.serial.exitFourWayInterface();
    } catch (e) {
      console.debug(e);

      try {
        this.serial.close();
      } catch(e) {
        console.debug(e);
      }

      this.addLogMessage('portUsed');

      return;
    }

    try {
      let apiVersion = null;

      try {
        apiVersion = await this.serial.getApiVersion();
      } catch(e) {
        if (e instanceof TimeoutError) {
          let hasResets = false;
          let i = 0;

          try {
            while ((await this.serial.getFourWayInterfaceInfo(i))) {
              await this.serial.resetFourWayInterface(i);
              i += 1;
            }
          } catch (ex) {
            if (!(ex instanceof MessageNotOkError)) {
              this.addLogMessage('resetEscFailedPowerCycle', { index: i + 1 });
              throw ex;
            }
          } finally {
            hasResets = i > 0;
          }

          if (hasResets) {
            await this.serial.exitFourWayInterface();
          }

          apiVersion = await this.serial.getApiVersion();
        } else {
          throw e;
        }
      }

      this.addLogMessage('mspApiVersion', { version: apiVersion.apiVersion });

      const fcVariant = await this.serial.getFcVariant();
      const fcVersion = await this.serial.getFcVersion();
      this.addLogMessage('mspFcInfo', {
        id: fcVariant.flightControllerIdentifier,
        version: fcVersion.flightControllerVersion,
      });

      const buildInfo = await this.serial.getBuildInfo();
      this.addLogMessage('mspBuildInfo', { info: buildInfo.buildInfo });

      const boardInfo = await this.serial.getBoardInfo();
      this.addLogMessage('mspBoardInfo', {
        identifier: boardInfo.boardIdentifier,
        version: boardInfo.boardVersion,
      });

      const uid = (await this.serial.getUid()).uid;
      let uidHex = 0;
      for (let i = 0; i < uid.length; i += 1) {
        uidHex += uid[i].toString(16);
      }
      this.addLogMessage('mspUid', { id: uidHex });

      let motorData = await this.serial.getMotorData();
      motorData = motorData.filter((motor) => motor > 0);

      const features = await this.serial.getFeatures();

      TagManager.dataLayer({
        dataLayer: {
          event: "FlightController",
          flightController: {
            mspVersion: apiVersion.apiVersion,
            firmwareName: fcVariant.flightControllerIdentifier,
            firmwareVersion: fcVersion.flightControllerVersion,
            firmwareBuild: buildInfo.buildInfo,
          },
        },
      });

      this.setState({ msp: { features } });
      this.setSerial({ open: true });
      this.setEscs({ connected: motorData.length });
    } catch(e) {
      this.serial.close();
      this.addLogMessage('portUsed');
    }

    this.setActions({ isConnecting: false });
  };

  handleDisconnect = async(e) => {
    e.preventDefault();
    TagManager.dataLayer({ dataLayer: { event: "Disconnect" } });

    this.setActions({ isDisconnecting: true });

    const { escs } = this.state;
    if(this.serial) {
      for(let i = 0; i < escs.individual.length; i += 1) {
        try {
          await this.serial.resetFourWayInterface(i);
        } catch(e) {
          this.addLogMessage('resetEscFailed', { index: i + 1 });
        }
      }
      await this.serial.exitFourWayInterface();

      this.serial.close();
    }

    this.lastConnected = 0;

    this.setSerial({
      fourWay: false,
      open: false,
    });

    this.setEscs({ individual: [] });

    this.setActions({
      isReading: false,
      isWriting: false,
      isSelecting: false,
      isFlashing: false,
      isConnecting: false,
      isDisconnecting: false,
    });

    this.addLogMessage('closedPort');
  };

  handleAllMotorSpeed = async(speed) => {
    await this.serial.spinAllMotors(speed);
  };

  handleSingleMotorSpeed = async(index, speed) => {
    await this.serial.spinMotor(index, speed);
  };

  handleCookieAccept = () => {
    if(!this.gtmActive) {
      const tagManagerArgs = { gtmId: process.env.REACT_APP_GTM_ID };
      TagManager.initialize(tagManagerArgs);

      this.gtmActive = true;
    }
  };

  handleMelodyWrite = (melodies) => {
    const { escs } = this.state;
    const individual = [ ...escs.individual ];
    const converted = melodies.map((melody) => Rtttl.toBluejayStartupMelody(melody));

    // Set wait time after melody to synchronize playback on all ESCs
    const melodyDurations = melodies.map((melody) => Rtttl.parse(melody).melody.reduce((a, b) => a + b.duration, 0));
    const maxMelodyDuration = Math.max(...melodyDurations);

    for(let i = 0; i < converted.length; i += 1) {
      individual[i].individualSettings.STARTUP_MELODY = converted[i].data;
      individual[i].individualSettings.STARTUP_MELODY_WAIT_MS = maxMelodyDuration - melodyDurations[i];
    }

    // Update individual settings, then write them.
    this.setEscs({ individual }, () => {
      this.handleWriteSettings();
    });
  };

  render() {
    const {
      escs,
      actions,
      configs,
      msp,
      serial,
    } = this.state;

    if (!serial.checked) {
      return null;
    }

    return (
      <MainApp
        actions={actions}
        configs={configs}
        escs={{
          actions: {
            handleMasterUpdate: this.handleSettingsUpdate,
            handleCommonSettingsUpdate: this.handleCommonSettingsUpdate,
            handleIndividualSettingsUpdate: this.handleIndividualSettingsUpdate,
            handleResetDefaultls: this.handleResetDefaultls,
            handleReadEscs: this.handleReadEscs,
            handleWriteSetup: this.handleWriteSettings,
            handleSingleFlash: this.handleSingleFlash,
            handleSelectFirmwareForAll: this.handleSelectFirmwareForAll,
            handleCancelFirmwareSelection: this.handleCancelFirmwareSelection,
            handleLocalSubmit: this.handleLocalSubmit,
            handleFlashUrl: this.handleFlashUrl,
            handleFirmwareDump: this.handleFirmwareDump,
          },
          ...escs,
        }}
        melodies={{ actions: { handleWrite: this.handleMelodyWrite } }}
        msp={msp}
        onAllMotorSpeed={this.handleAllMotorSpeed}
        onClearLog={this.handleClearLog}
        onCookieAccept={this.handleCookieAccept}
        onSaveLog={this.handleSaveLog}
        onSingleMotorSpeed={this.handleSingleMotorSpeed}
        serial={{
          actions: {
            handleChangePort: this.handleChangePort,
            handleConnect: this.handleConnect,
            handleDisconnect: this.handleDisconnect,
            handleSetBaudRate: this.handleSetBaudRate,
            handleSetPort: this.handleSetPort,
          },
          port: this.serial,
          ...serial,
        }}
      />
    );
  }
}

export default App;
