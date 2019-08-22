import React, { PureComponent } from 'react';

import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  FlatList,
  Image,
  Text,
  TextInput,
  View,
  Linking,
  ScrollView,
  TouchableHighlight,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Keyboard,
} from 'react-native';

import OVComponent from '../OVComponent';

import Accordion from 'react-native-collapsible/Accordion';
import { BottomNavigation } from 'react-native-material-ui';
import { NavigationActions } from 'react-navigation';
import storage from 'react-native-storage-wrapper';
import NetInfo from '@react-native-community/netinfo';
import DeviceInfo from 'react-native-device-info';
import Icon from 'react-native-vector-icons/FontAwesome';
import MapView, { PROVIDER_GOOGLE } from 'react-native-maps'
import RNGooglePlaces from 'react-native-google-places';
import { Divider, api_base_uri, _doGeocode, _getApiToken, getEpoch } from '../../common';
import KnockPage from '../KnockPage';
import CanvassingSettingsPage from '../CanvassingSettingsPage';
import Modal from 'react-native-simple-modal';
import md5 from 'md5';
import { debounce } from 'throttle-debounce';
import { orderBy } from 'natural-orderby';
import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'
import t from 'tcomb-form-native';
import _ from 'lodash';

import {deepCopy, geojson2polygons, ingeojson} from 'ourvoiceusa-sdk-js';

TimeAgo.addLocale(en);

var Form = t.form.Form;

var formStreet = t.struct({
  'street': t.String,
});
var formCity = t.struct({
  'city': t.String,
});
var formState = t.struct({
  'state': t.String,
  'zip': t.String,
});
var unitForm = t.struct({
  'unit': t.String,
});

const formStyleRow = _.cloneDeep(t.form.Form.stylesheet);
formStyleRow.fieldset = {
  flexDirection: 'row'
};
formStyleRow.formGroup.normal.flex = 1;
formStyleRow.formGroup.error.flex = 1;

const formOptRow = {
  stylesheet: formStyleRow,
};

function bystreet(a,b) {
  let na = parseInt(a.address.street.replace(/(\d+) .*/, '$1'));
  let nb = parseInt(b.address.street.replace(/(\d+) .*/, '$1'));

  if ( na < nb )
    return -1;
  if ( na > nb )
    return 1;
  return 0;
}

export default class App extends OVComponent {

  constructor(props) {
    super(props);

    this.state = {
      refer: props.navigation.state.params.refer,
      server: props.navigation.state.params.server,
      active: 'map',
      selectedTurf: {},
      listview: {},
      listview_order: [],
      activeCity: [0],
      activeStreet: [],
      last_fetch: 0,
      mapCenter: {},
      loading: false,
      fetching: false,
      fetchingHistory: false,
      fetchingTurfStats: false,
      checkHistory: true,
      history: [],
      turfStats: {},
      netInfo: 'none',
      serviceError: null,
      myPosition: {latitude: null, longitude: null},
      lastFetchPosition: {latitude: null, longitude: null},
      region: {latitudeDelta: 0.004, longitudeDelta: 0.004},
      markers: [],
      searchPins: [],
      fAddress: {},
      pAddress: {},
      fUnit: {},
      DisclosureKey : 'OV_DISCLOUSER',
      settingsStorageKey: 'OV_CANVASS_SETTINGS',
      canvassSettings: {},
      isModalVisible: false,
      isKnockMenuVisible: false,
      newUnitModalVisible: false,
      showDisclosure: "true",
      form: props.navigation.state.params.form,
      orgId: props.navigation.state.params.orgId,
      user: props.navigation.state.params.user,
      turfs: props.navigation.state.params.form.turfs,
      retry_queue: [],
    };

    if (this.state.form.add_new) this.add_new = true;

    this.onChange = this.onChange.bind(this);
    this.onUnitChange = this.onUnitChange.bind(this);
    this.onRegionChange = this.onRegionChange.bind(this);
    this.handleConnectivityChange = this.handleConnectivityChange.bind(this);

    this._dataGet = debounce(500, this._dataFetch)

    // confirm exit, and reload forms when they do
    this.goBack = this.props.navigation.goBack;
    this.props.navigation.goBack = () => {
      Alert.alert(
        'Exit Canvassing',
        'Are you sure you wish to exit the canvassing?',
        [
          {text: 'Yes', onPress: () => {
            this.state.refer._loadForms();
            this.goBack();
          }},
          {text: 'No'},
        ], { cancelable: false }
      );
    };
  }

  componentDidMount() {
    this._getCanvassSettings();
    this.requestLocationPermission();
    this.setupConnectionListener();
    this.LoadDisclosure(); //Updates showDisclosure state if the user previously accepted
    this.loadRetryQueue();
  }

  onRegionChange(region) {
    this.setState({mapCenter: region})
    if (this.state.canvassSettings.chill_mode !== true) this._dataGet(region);
  }

  setupConnectionListener = async () => {
    try {
      let ci = await NetInfo.getConnectionInfo();
      this.handleConnectivityChange(ci);
    } catch (e) {}

    NetInfo.addEventListener(
     'connectionChange',
     this.handleConnectivityChange
    );
  }

  handleConnectivityChange(ci) {
    let state = 'none';
    try {
      switch (ci.type) {
        case 'wifi':
        case 'bluetooth':
        case 'ethernet':
          state = 'wifi';
          break;
        case 'cellular':
        case 'wimax':
          state = 'cellular';
          break;
      }
    } catch (e) {}
    this.setState({netInfo: state});

    if (state === 'wifi' || state === 'cellular') this.doRetry();
  }

  _getCanvassSettings = async () => {
    const { form } = this.state;

    let canvassSettings = {};
    try {
      const value = await storage.get(this.state.settingsStorageKey);
      if (value !== null) {
        canvassSettings = JSON.parse(value);
      }
    } catch (e) {
      console.warn(e);
      return;
    }

    // set some defaults
    if (!canvassSettings.limit) canvassSettings.limit = '100';
    if (form.default_filters && !canvassSettings.filters) {
      canvassSettings.filter_pins = true;
      canvassSettings.filters = deepCopy(form.default_filters);
    }

    this.setState({ canvassSettings });
  }

  _setCanvassSettings = async (canvassSettings) => {
    const { form, lastFetchPosition } = this.state;

    try {
      if (!canvassSettings.limit) canvassSettings.limit = '100';
      let str = JSON.stringify(canvassSettings);
      await storage.set(this.state.settingsStorageKey, str);
      this.setState({canvassSettings}, () => this._dataGet(lastFetchPosition, true));
    } catch (e) {}

  }

  componentDidUpdate(prevProps, prevState) {
    const { active, canvassSettings, checkHistory } = this.state;

    if (prevState.active !== active) {
      // close any open modals
      this.setState({isModalVisible: false, isKnockMenuVisible: false});

      // reload filters, etc
      if (prevState.active === 'settings') this._setCanvassSettings(canvassSettings);

      // poll history if needed
      if (active === 'history' && checkHistory) this._pollHistory();
    }
  }

  componentWillUnmount() {
    this.cleanupLocation();
    NetInfo.removeEventListener(
      'connectionChange',
      this.handleConnectivityChange
    );
  }

  dropSearchPin(place) {
    let { searchPins } = this.state;
    searchPins.push(place);
    this.setState({searchPins});
  }

  _pollHistory = async () => {

    this.setState({fetchingHistory: true});

    try {
      let https = true;
      if (this.state.server.match(/:8080/)) https = false;
      let res = await fetch(
        'http'+(https?'s':'')+'://'+this.state.server+api_base_uri(this.state.orgId)+'/volunteer/visit/history?formId='+this.state.form.id,
      {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer '+await _getApiToken(),
          'Content-Type': 'application/json',
        },
      });

      let json = await res.json();

      if (res.status !== 200 || json.error === true) {
        if (json.msg) ret.msg = json.msg;
        throw "Sync error";
      }

      this.setState({history: json, checkHistory: false});
    } catch (e) {
      this.triggerNetworkWarning();
    }

    this.setState({fetchingHistory: false});
  }

  addOk = () => {
    if (this.state.canvassSettings.filter_pins) return false;
    if (this.state.canvassSettings.filter_visited) return false;
    return true;

  }

  showConfirmAddress = (pos) => {
    const { myPosition } = this.state;

    if (!this.addOk()) {
      Alert.alert('Active Filter', 'You cannot add a new address while a filter is active.', [{text: 'OK'}], { cancelable: false });
      return;
    }

    if (this.state.netInfo === 'none') {
      this.setState({ isModalVisible: true });
      return;
    }

    if (!pos) pos = myPosition;

    if (pos.latitude !== null && pos.longitude !== null) {
      if (this.state.turfs && this.state.turfs.length) {
        let flag = false;
        this.state.turfs.forEach(t => {
          if (ingeojson(t, pos.longitude, pos.latitude)) flag = true;
        });
        if (!flag) {
          Alert.alert('Outside Boundary', 'You are outside the turf boundary for this canvassing form.', [{text: 'OK'}], { cancelable: false });
          return;
        }
      }
    }

    this.setState({
      loading: true,
      isModalVisible: true,
    });

    setTimeout(async () => {
      try {
        if (this.state.locationAccess === false) throw "location access denied";

        let res = await _doGeocode(pos.longitude, pos.latitude);

        if (!res.error) {
          let arr = res.address.split(", ");
          let country = arr[arr.length-1]; // unused
          let state_zip = arr[arr.length-2];
          let fAddress = {
            state: (state_zip?state_zip.split(" ")[0]:null),
            zip: (state_zip?state_zip.split(" ")[1]:null),
            city: arr[arr.length-3],
            street: arr[arr.length-4],
            longitude: pos.longitude,
            latitude: pos.latitude,
          };

          this.setState({fAddress});
        }
      } catch (error) {}
      this.setState({loading: false})
    }, 550);
  }

  onChange(fAddress) {
    this.setState({fAddress});
  }

  onUnitChange(fUnit) {
    this.setState({fUnit});
  }

  getEpoch() {
    return Math.floor(new Date().getTime())
  }

  doConfirmAddress = async () => {
    const { myPosition, form, markers } = this.state;
    let { fAddress } = this.state;

    let jsonStreet = this.refs.formStreet.getValue();
    let jsonCity = this.refs.formCity.getValue();
    let jsonState = this.refs.formState.getValue();

    if (jsonStreet === null || jsonCity === null || jsonState === null) return;

    try {
      await this.map.animateToCoordinate({longitude: fAddress.longitude, latitude: fAddress.latitude}, 500)
    } catch (error) {}

    let epoch = this.getEpoch();

    fAddress.street = jsonStreet.street.trim();
    fAddress.city = jsonCity.city.trim();
    fAddress.state = jsonState.state.trim();
    fAddress.zip = jsonState.zip.trim();

    // search for dupes
    let marker;
    markers.forEach(m => {
      // change nulls to empty string
      ["street", "city", "state", "zip"].forEach(i => {if (!m.address[i]) m.address[i] = "";});

      if (m.address.street.toLowerCase() === fAddress.street.toLowerCase() &&
          m.address.city.toLowerCase() === fAddress.city.toLowerCase() &&
          m.address.state.toLowerCase() === fAddress.state.toLowerCase() &&
          m.address.zip.substring(0, 5) === fAddress.zip.substring(0, 5)) marker = m;
    });

    if (!marker) {
      marker = {
        people: [],
        units: [],
        address: {
          id: md5(fAddress.street.toLowerCase()+fAddress.city.toLowerCase()+fAddress.state.toLowerCase()+fAddress.zip.substring(0, 5)),
          longitude: fAddress.longitude,
          latitude: fAddress.latitude,
          street: fAddress.street,
          city: fAddress.city,
          state: fAddress.state,
          zip: fAddress.zip,
        },
      };

      let input = {
        deviceId: DeviceInfo.getUniqueID(),
        formId: form.id,
        timestamp: getEpoch(),
        longitude: fAddress.longitude,
        latitude: fAddress.latitude,
        street: marker.address.street,
        city: marker.address.city,
        state: marker.address.state,
        zip: marker.address.zip,
      };

      this.sendData('/address/add/location', input);

      markers.push(marker);
    }

    this.setState({ markers, fAddress, pAddress: fAddress, searchPins: [], isModalVisible: false });
    this.doMarkerPress(marker);
  }

  doMarkerPress = (marker) => {
    const { navigate } = this.props.navigation;
    const { form } = this.state;

    this.currentMarker = marker;

    if (marker.units.length)
      this.setState({active: 'multiunit'});
    else
      this.setState({isKnockMenuVisible: true});
  }

  getCurrentMarker() { return this.currentMarker; }

  ucFirst(str) {
      return str.charAt(0).toUpperCase() + str.slice(1);
  }

  getLastVisitObj(place) {
    let latest = {status:-1,end:0};

    if (!place.visits || place.visits.length === 0)
      return latest;

    for (let i in place.visits) {
      if (place.visits[i].status !== 3 && place.visits[i].end > latest.end) latest = place.visits[i];
    }

    return latest;
  }

  getLastVisit(place) {
    let str;
    let v = this.getLastVisitObj(place);

    switch (v.status) {
      case 0: str = "Not home"; break;
      case 1: str = "Home"; break;
      case 2: str = "Not interested"; break;
      default: str = "Haven't visited"; break;
    }

    return str+(v.end?" "+new TimeAgo('en-US').format(v.end):'');
  }

  LoadDisclosure = async () => {
    try {
      const value = await storage.get(this.state.DisclosureKey);
      if (value !== null) {
        this.setState({showDisclosure : value});
      }
    } catch (error) {}
  }

  SaveDisclosure = async () => {
    try {
      await storage.set(this.state.DisclosureKey, "false");
    } catch (error) {}
  }

  updateLocalMarker(place, input) {
    // add interaction locally so app updates color
    if (!place.visits) place.visits = [];
    place.visits.push(input);
    this.forceUpdate();
  }

  _loadTurfStats = async () => {
    const { selectedTurf } = this.state;

    return; // TODO: enable turf stats

    this.setState({active: 'turfstats', fetchingTurfStats: true});

    try {
      let https = true;
      if (this.state.server.match(/:8080/)) https = false;
      let res = await fetch(
        'http'+(https?'s':'')+'://'+this.state.server+api_base_uri(this.state.orgId)+'/turf/get?turfId='+selectedTurf.id,
      {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer '+await _getApiToken(),
          'Content-Type': 'application/json',
        },
      });

      let json = await res.json();

      if (res.status !== 200 || json.error === true) {
        if (json.msg) ret.msg = json.msg;
        throw "Sync error";
      }

      this.setState({turfStats: json});
    } catch (e) {
      this.triggerNetworkWarning();
    }

    this.setState({fetchingTurfStats: false});
  }

  _dataFetch = async (pos, flag) => {
    const { canvassSettings, myPosition, lastFetchPosition, fetching } = this.state;
    let ret = {error: false};

    if (!pos) pos = myPosition;

    if (!pos.longitude || !pos.latitude) return;

    if (fetching) return;

    this.setState({fetching: true});

    try {
      let https = true;
      if (this.state.server.match(/:8080/)) https = false;
      let res = await fetch('http'+(https?'s':'')+'://'+this.state.server+api_base_uri(this.state.orgId)+'/people/get/byposition', {
        method: 'POST',
        body: JSON.stringify({
          formId: this.state.form.id,
          longitude: pos.longitude,
          latitude: pos.latitude,
          limit: (canvassSettings.limit?canvassSettings.limit:100),
          filter_visited: (canvassSettings.filter_visited?'home':undefined),
          filters: (canvassSettings.filter_pins&&canvassSettings.filters?canvassSettings.filters:undefined),
        }),
        headers: {
          'Authorization': 'Bearer '+await _getApiToken(),
          'Content-Type': 'application/json',
        },
      });

      let json = await res.json();

      if (res.status !== 200 || json.error === true) {
        if (json.msg) ret.msg = json.msg;
        throw "Sync error";
      }

      let listview = {};
      let listview_order = [];
      let cities = [];
      let streets = [];

      // gather unique cities & streets
      json.forEach((marker) => {
        // catch null markers
        if (!marker.address) {
          console.warn("Null address on marker: ", marker);
          marker.address = {longitude: 0, latitude: 0, id: parseInt(Math.random()*1000)};
          return;
        }
        let street = marker.address.street.replace(/\d+ /, '');

        if (!listview[street]) {
          listview[street] = [];
          listview_order.push(street);
        }

        listview[street].push(marker);
      });

      Object.keys(listview).forEach((street) => listview[street].sort(bystreet));

      this.setState({lastFetchPosition: pos, markers: json, listview, listview_order, last_fetch: getEpoch()});
    } catch (e) {
      console.warn("Error: "+e);
      ret.error = true;
      this.triggerNetworkWarning();
    }

    this.setState({fetching: false});

    return ret;
  }

  sendVisit(id, place, unit, person, start, json) {
    const { form, myPosition } = this.state;
    let attrs = [];

    // convert object key/value to an array of id/value
    let ids = Object.keys(json);
    for (let i in ids) {
      attrs.push({
        id: ids[i],
        value: (json[ids[i]]?json[ids[i]]:""),
      });
    }

    let input = {
      deviceId: DeviceInfo.getUniqueID(),
      addressId: id,
      formId: form.id,
      status: 1,
      start: start,
      end: getEpoch(),
      longitude: myPosition.longitude,
      latitude: myPosition.latitude,
      personId: person.id,
      attrs: attrs,
    };

    if (unit) input.unit = unit.name;

    this.updateLocalMarker(place, input);

    if (person.new) place.people.push(person);

    this.sendData('/people/visit/'+(person.new?'add':'update'), input);
  }

  sendStatus(status, id, place, unit, personId) {
    const { form, myPosition } = this.state;

    let now = getEpoch();

    let input = {
      deviceId: DeviceInfo.getUniqueID(),
      addressId: id,
      formId: form.id,
      status: status,
      start: now,
      end: now,
      longitude: myPosition.longitude,
      latitude: myPosition.latitude,
    };

    if (unit) input.unit = unit.name;
    if (personId) input.personId = personId;

    this.updateLocalMarker(place, input);

    this.sendData('/people/visit/update', input);
  }

  sendData = async (uri, input) => {
    try {
      let https = true;
      if (this.state.server.match(/:8080/)) https = false;
      let res = await fetch('http'+(https?'s':'')+'://'+this.state.server+api_base_uri(this.state.orgId)+uri, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer '+await _getApiToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      if (res.status !== 200) {
        throw "sendData error";
      }

      this.setState({checkHistory: true});

    } catch (e) {
      this.triggerNetworkWarning();
      await this.queueRetry(uri, input);
    }
  }

  queueRetry = async (uri, input) => {
    let { retry_queue } = this.state;
    retry_queue.push({uri: uri, input: input});
    this.setState({retry_queue});
    try {
      await storage.set('OV_RETRY', JSON.stringify(retry_queue));
    } catch(e) {
      console.warn(e);
    }
  }

  doRetry = async () => {
    let queue = deepCopy(this.state.retry_queue);

    if (this.state.retry_running) return;
    this.setState({retry_running: true, retry_queue: []});

    for (let i in queue) {
      let input = queue[i].input;
      let uri = queue[i].uri;
      await this.sendData(uri, input);
    }

    try {
      await storage.del('OV_RETRY');
      this._dataGet();
    } catch (e) {
      console.warn(e);
    }

    this.setState({retry_running: false});
  }

  loadRetryQueue = async () => {
    try {
      const value = await storage.get('OV_RETRY');
      if (value !== null)
        this.setState({retry_queue: JSON.parse(value)}, () => this.doRetry());
    } catch(e) {
      console.warn(e);
    }
  }

  addUnit = async () => {
    let { form, myPosition } = this.state;

    let json = this.refs.unitForm.getValue();
    if (json == null) return;

    // search for dupes
    let dupe = false;
    this.currentMarker.units.forEach(u => {
      if (u.name.toLowerCase() === json.unit.toLowerCase()) dupe = true;
    });

    if (!dupe) {
      let input = {
        deviceId: DeviceInfo.getUniqueID(),
        formId: form.id,
        timestamp: this.getEpoch(),
        longitude: myPosition.longitude,
        latitude: myPosition.latitude,
        unit: json.unit,
        addressId: this.currentMarker.address.id,
      };

      this.sendData('/address/add/unit', input);
      this.currentMarker.units.push({name: json.unit, people: []});
    }

    this.setState({newUnitModalVisible: false, fUnit: {}});
  }

  notHome = async (id, place, unit) => {
    this.sendStatus(0, id, place, unit);
  }

  notInterested = async (id, place, unit) => {
    this.sendStatus(2, id, place, unit);
  }

  personMoved = async (id, place, unit, personId) => {
    this.sendStatus(3, id, place, unit, personId);
  }

  triggerNetworkWarning() {
    // TODO: bar that appears at the top and a tap retries
  }

  getPinColor(place) {
    if (place.units && place.units.length) return "cyan";

    let str;
    let v = this.getLastVisitObj(place);

    switch (v.status) {
      case 0: return 'yellow';
      case 1: return 'green';
      case 2: return 'red';
      default: return '#8b4513';
    }
  }

  _canvassGuidelinesUrlHandler() {
    const url = "https://github.com/OurVoiceUSA/HelloVoter/blob/master/docs/Canvassing-Guidelines.md";
    return Linking.openURL(url).catch(() => null);
  }

  acstreet = (street) => this.state.listview[street].map((marker, idx) => {
    let color = this.getPinColor(marker);
    let icon = (color === "red" ? "ban" : "home");
    let num_people = marker.people.length;
    marker.units.forEach((u) => num_people+=u.people.length);

    return (
      <View key={idx} style={{padding: 10, paddingTop: 0}}>
        <TouchableOpacity
          style={{flexDirection: 'row', alignItems: 'center'}}
          onPress={() => this.doMarkerPress(marker)}>
          <Icon name={icon} size={40} color={color} style={{margin: 5}} />
          <Text>{marker.address.street} - {this.getLastVisit(marker)} ({num_people})</Text>
          </TouchableOpacity>
          <Divider />
        </View>
      );
    }
  )

  acrh = (street, idx) => (
    <View>
      <View style={{flex: 1, flexDirection: 'row'}}>
        <Icon
          style={{margin: 20, marginRight: 10}}
          size={20}
          name={(parseInt(this.state.activeStreet)===idx?"minus-circle":"plus-circle")}
          backgroundColor="#d7d7d7"
          color="black"
        />
        <Text style={{alignSelf: 'center', margin: 20, marginLeft: 10}}>{street} ({this.state.listview[street].length})</Text>
      </View>
      <Divider />
    </View>
  )

  acoc = (activeStreet) => this.setState({activeStreet})

  updateTurfInfo(pos) {
    if (this.state.turfs) {
      let selectedTurf = {};
      for (let i in this.state.turfs) {
        if (ingeojson(this.state.turfs[i], pos.longitude, pos.latitude)) {
          selectedTurf = this.state.turfs[i];
          break;
        }
      }
      this.setState({selectedTurf});
    }
  }

  render() {
    const { navigate } = this.props.navigation;
    const {
      showDisclosure, myPosition, myNodes, locationAccess, serviceError, form, user,
      loading, region, active, fetching, selectedTurf, mapCenter
    } = this.state;

    if (showDisclosure === "true") {
      return (
        <ScrollView style={{flex: 1, backgroundColor: 'white'}}>
          <View style={styles.content}>
            <Text style={{margin: 15, fontSize: 18, color: 'dimgray'}}>
              Our Voice provides this canvassing tool for free for you to use for your own purposes. You will be talking
              to real people and asking real questions about policy positions that matter, and hopefully also collaborating
              with other canvassers. Together, we can crowd source the answers to how our country thinks outside of
              partisan politics.
            </Text>

            <View style={{margin: 15}}>
              <Text style={{fontSize: 18, color: 'dimgray'}}>
                By using this tool you acknowledge that you are acting on your own behalf, do not represent Our Voice USA
                or its affiliates, and have read our <Text style={{fontSize: 18, fontWeight: 'bold', color: 'blue'}} onPress={() => {this._canvassGuidelinesUrlHandler()}}>
                canvassing guidelines</Text>. Please be courteous to those you meet.
              </Text>
            </View>

                <View style={{margin: 5, flexDirection: 'row'}}>
                  <Icon.Button
                    name="check-circle"
                    backgroundColor="#d7d7d7"
                    color="#000000"
                    onPress={() => {
                      this.setState({ showDisclosure: "false"}); //Hide disclosure
                      this.SaveDisclosure(); //Save the disclosures acceptance
                    }}
                    {...iconStyles}>
                    I understand & agree to the guidelines
                  </Icon.Button>
                </View>

                <View style={{margin: 5, flexDirection: 'row'}}>
                  <Icon.Button
                    name="ban"
                    backgroundColor="#d7d7d7"
                    color="#000000"
                    onPress={() => {this.props.navigation.dispatch(NavigationActions.back())}}
                    {...iconStyles}>
                    I do not agree to this! Take me back!
                  </Icon.Button>
                </View>

          </View>
        </ScrollView>
      );
    }

    var nomap_content = [];

    if (locationAccess === false) {
      nomap_content.push(
        <View key={1} style={styles.content}>
          <Text>Unable to determine your location.</Text>
          <Text>To view the map, enable location permissions in your device settings.</Text>
        </View>
      );
    } else if (serviceError === true) {
      nomap_content.push(
        <View key={1} style={styles.content}>
          <Text>Unable to load location services from your device.</Text>
        </View>
      );
    } else if (myPosition.latitude === null || myPosition.longitude === null) {
      nomap_content.push(
        <View key={1} style={styles.content}>
          <Text>Waiting on location data from your device...</Text>
          <ActivityIndicator />
        </View>
      );
    }

    let geofence = [];
    if (this.state.turfs) {
      for (let i in this.state.turfs) {
        geojson2polygons(this.state.turfs[i], true).forEach(polygon => geofence.push({id: this.state.turfs[i].id, name: this.state.turfs[i].name, polygon: polygon}));
      }
    }

    return (
      <View style={{flex: 1}}>
        <ScrollView style={{flex: 1, backgroundColor: '#FFF'}}>
        {active==='turfstats'&&
          <TurfStats refer={this} loading={this.state.fetchingTurfStats} data={this.state.turfStats} />
        }
        {active==='multiunit'&&
        <View>
          <Text style={{fontSize: 20, padding: 10}}>{this.currentMarker.address.street}, {this.currentMarker.address.city}</Text>

          {this.add_new &&
          <Icon.Button
            name="plus-circle"
            backgroundColor="#d7d7d7"
            color="#000000"
            onPress={() => {
              if (!this.addOk()) {
                Alert.alert('Active Filter', 'You cannot add a new address while a filter is active.', [{text: 'OK'}], { cancelable: false });
                return;
              }
              this.setState({ newUnitModalVisible: true });
            }}
            {...iconStyles}>
            Add new unit/apt number
          </Icon.Button>
          }

          {(this.currentMarker.people && this.currentMarker.people.length !== 0) &&
          <Unit unit={this.currentMarker}
            unknown={true}
            refer={this}
            color={this.getPinColor(this.currentMarker)} />
          }

          <FlatList
            scrollEnabled={false}
            data={orderBy(this.currentMarker.units, u => u.name)}
            extraData={this.state}
            keyExtractor={item => item.name}
            renderItem={({item}) => (
              <Unit unit={item}
                refer={this}
                color={this.getPinColor(item)} />
            )} />
        </View>
        }
        {active==='list'&&
          <View>
          {this.state.listview_order.length&&
            <Accordion
              activeSections={this.state.activeStreet}
              sections={this.state.listview_order}
              renderSectionTitle={() => null}
              renderHeader={this.acrh}
              renderContent={this.acstreet}
              onChange={this.acoc}
            />
          ||
            <Text style={{margin: 10}}>No address data for this area. Try widening your view on the map or adjusting your filter settings.</Text>
          }
          </View>
        }
        {active==='history'&&
          <History refer={this} loading={this.state.fetchingHistory} data={this.state.history} onPress={(pos) => {
            this.setState({active: 'map'});
            if (this.state.canvassSettings.chill_mode) this._dataGet(pos);
            this.map.animateToCoordinate(pos, 1000);
          }} />
        }
        {active==='settings'&&
          <CanvassingSettingsPage refer={this} form={form} />
        }
        </ScrollView>

        {nomap_content.length &&
          <View>
            { nomap_content }
          </View>
        ||
        <MapView
          ref={component => this.map = component}
          initialRegion={{latitude: myPosition.latitude, longitude: myPosition.longitude, latitudeDelta: region.latitudeDelta, longitudeDelta: region.longitudeDelta}}
          onMapReady={() => {
            this.setState({mapCenter: myPosition});
            this.map.animateToRegion({
              latitude: myPosition.latitude,
              longitude: myPosition.longitude,
              latitudeDelta: region.latitudeDelta,
              longitudeDelta: region.longitudeDelta,
            });
          }}
          provider={PROVIDER_GOOGLE}
          style={(active==='map'?styles.map:null)}
          showsUserLocation={true}
          followsUserLocation={false}
          keyboardShouldPersistTaps={true}
          onRegionChangeComplete={this.onRegionChange}
          showsIndoors={false}
          showsTraffic={false}
          onPress={(e) => e.nativeEvent.coordinate && this.updateTurfInfo(e.nativeEvent.coordinate)}
          onLongPress={(e) => this.add_new && e.nativeEvent.coordinate && this.showConfirmAddress(e.nativeEvent.coordinate)}
          {...this.props}>
          {geofence.map((g, idx) => <MapView.Polyline key={idx} coordinates={g.polygon} strokeWidth={2} strokeColor={(g.id === selectedTurf.id ? "blue" : "black")} />)}
          {this.state.markers.map((marker) => (
              <MapView.Marker
                key={marker.address.id}
                coordinate={{longitude: marker.address.longitude, latitude: marker.address.latitude}}
                onPress={(e) => e.nativeEvent.coordinate && this.updateTurfInfo(e.nativeEvent.coordinate)}
                pinColor={this.getPinColor(marker)}>
                <MapView.Callout onPress={() => this.doMarkerPress(marker)}>
                  <View style={{backgroundColor: '#FFFFFF', padding: 5, width: 175}}>
                    <Text style={{fontWeight: 'bold'}}>
                      {marker.address.street}, {marker.address.city}, {marker.address.state}, {marker.address.zip}
                    </Text>
                    <Text>{(marker.units.length ? 'Multi-unit address' : this.getLastVisit(marker))}</Text>
                  </View>
                </MapView.Callout>
              </MapView.Marker>
          ))}
          {this.state.searchPins.map((place, idx) => (
              <MapView.Marker
                key={idx}
                coordinate={place.location}
                onPress={(e) => e.nativeEvent.coordinate && this.updateTurfInfo(e.nativeEvent.coordinate)}
                pinColor={"purple"}>
                <MapView.Callout onPress={() => this.add_new && this.showConfirmAddress(place.location)}>
                  <View style={{backgroundColor: '#FFFFFF', padding: 5, width: 175}}>
                    <Text style={{fontWeight: 'bold'}}>
                      {place.address}
                    </Text>
                    {this.add_new&&<Text>Tap to add this address.</Text>}
                  </View>
                </MapView.Callout>
              </MapView.Marker>
          ))}
        </MapView>
        }

        {fetching&&
        <View style={{position: 'absolute', right: 0, ...styles.iconContainer}}>
          <ActivityIndicator size="large" />
        </View>
        }

        {active==='map'&&selectedTurf.id&&
        <TouchableOpacity style={{position: 'absolute', left: 0, ...styles.turfInfoContainer}}
          onPress={() => this._loadTurfStats()}>
          <Text>{selectedTurf.name}</Text>
        </TouchableOpacity>
        }

        {active==='map' && nomap_content.length === 0 &&
        <View style={{alignItems: 'center', justifyContent: 'flex-end'}}>
          <View style={styles.buttonContainer}>

            {this.state.canvassSettings.chill_mode &&
            <TouchableOpacity style={styles.iconContainer} disabled={fetching}
              onPress={() => this._dataGet(mapCenter)}>
              <Icon
                name="refresh"
                size={50}
                color={(fetching?"#d3d3d3":"#00a86b")}
                {...iconStyles} />
            </TouchableOpacity>
            }

            <TouchableOpacity style={styles.iconContainer}
              onPress={() => {
                if (this.state.canvassSettings.chill_mode) this._dataGet(myPosition);
                this.map.animateToCoordinate(myPosition, 1000);
              }}>
              <Icon
                name="location-arrow"
                size={50}
                color="#0084b4"
                {...iconStyles} />
            </TouchableOpacity>

            <TouchableOpacity style={styles.iconContainer}
              onPress={() => {
                RNGooglePlaces.openAutocompleteModal(
                  {
                    locationBias: {
                      latitudeNE: mapCenter.latitude+0.1,
                      longitudeNE: mapCenter.longitude+0.1,
                      latitudeSW: mapCenter.latitude-0.1,
                      longitudeSW: mapCenter.longitude-0.1,
                    }
                  },
                  ['location','address']
                ).then((place) => {
                  this.dropSearchPin(place);
                  this.map.animateToCoordinate(place.location, 1000);
                })
                .catch(e => {});
              }}>
              <Icon
                name="search"
                size={40}
                color="#000000"
                {...iconStyles} />
            </TouchableOpacity>

          </View>
        </View>
        }

        <Modal
          open={this.state.isModalVisible}
          modalStyle={{width: 350, height: 400, backgroundColor: "transparent",
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0}}
          style={{alignItems: 'center'}}
          offset={0}
          overlayBackground={'rgba(0, 0, 0, 0.75)'}
          animationDuration={200}
          animationTension={40}
          modalDidOpen={() => undefined}
          modalDidClose={() => this.setState({isModalVisible: false})}
          closeOnTouchOutside={true}
          disableOnBackPress={false}>
          <View style={{flexDirection: 'column'}}>
            <View style={{width: 325, backgroundColor: 'white', marginTop: 5, borderRadius: 15, padding: 10, alignSelf: 'flex-start'}}>
              {loading &&
              <View>
                <Text style={{color: 'blue', fontWeight: 'bold', fontSize: 15}}>Loading Address</Text>
                <ActivityIndicator size="large" />
              </View>
              ||
              <View>
                <View style={{flexDirection: 'row'}}>
                  <Text style={{color: 'blue', fontWeight: 'bold', fontSize: 15}}>Confirm the Address</Text>
                  <View style={{flexDirection: 'row'}}>
                    <TouchableOpacity
                      style={{
                        backgroundColor: '#d7d7d7', padding: 10, borderRadius: 20, marginLeft: 5,
                        ...((this.state.pAddress.street && this.state.pAddress.street !== this.state.fAddress.street) ? {} : displayNone)
                      }}
                      onPress={() => {this.setState({fAddress: this.state.pAddress})}}>
                      <Text style={{textAlign: 'center'}}>Use Previous</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={{
                        backgroundColor: '#d7d7d7', padding: 10, borderRadius: 20, marginLeft: 5,
                        ...(this.state.netInfo === 'none' ? displayNone : {})
                      }}
                      onPress={() => this.showConfirmAddress()}>
                      <Text style={{textAlign: 'center'}}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <Form
                 ref="formStreet"
                 type={formStreet}
                 onChange={this.onChange}
                 value={this.state.fAddress}
                />
                <Form
                 ref="formCity"
                 type={formCity}
                 onChange={this.onChange}
                 options={formOptRow}
                 value={this.state.fAddress}
                />
                <Form
                 ref="formState"
                 type={formState}
                 onChange={this.onChange}
                 options={formOptRow}
                 value={this.state.fAddress}
                />
                <TouchableHighlight style={styles.addButton} onPress={this.doConfirmAddress} underlayColor='#99d9f4'>
                  <Text style={styles.buttonText}>Add</Text>
                </TouchableHighlight>
              </View>
              }
            </View>
          </View>
        </Modal>

        <Modal
          open={this.state.isKnockMenuVisible}
          modalStyle={{width: 335, height: 350, backgroundColor: "transparent",
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0}}
          style={{alignItems: 'center'}}
          offset={0}
          overlayBackground={'rgba(0, 0, 0, 0.75)'}
          animationDuration={200}
          animationTension={40}
          modalDidOpen={() => undefined}
          modalDidClose={() => this.setState({isKnockMenuVisible: false})}
          closeOnTouchOutside={true}
          disableOnBackPress={false}>
          <KnockPage refer={this} funcs={this} marker={this.currentMarker} unit={this.state.currentUnit} form={form} />
        </Modal>

        <Modal
          open={this.state.newUnitModalVisible}
          modalStyle={{width: 335, height: 250, backgroundColor: "transparent",
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0}}
          style={{alignItems: 'center'}}
          offset={0}
          overlayBackground={'rgba(0, 0, 0, 0.75)'}
          animationDuration={200}
          animationTension={40}
          modalDidOpen={() => undefined}
          modalDidClose={() => this.setState({newUnitModalVisible: false})}
          closeOnTouchOutside={true}
          disableOnBackPress={false}>
          <View style={styles.container}>
            <View>
              <View style={{flex: 1, flexDirection: 'row', margin: 20, alignItems: 'center'}}>
                <Text>Recording a new unit for this address:</Text>
              </View>
              <Form
                ref="unitForm"
                type={unitForm}
                options={{fields: {unit: {autoFocus: true}}}}
                onChange={this.onUnitChange}
                value={this.state.fUnit}
              />
              <TouchableHighlight style={styles.button} onPress={this.addUnit} underlayColor='#99d9f4'>
                <Text style={styles.buttonText}>Add</Text>
              </TouchableHighlight>
            </View>
          </View>
        </Modal>

        <BottomNavigation active={this.state.active} hidden={false} >
          <BottomNavigation.Action
            key="map"
            icon="map"
            label="Map View"
            onPress={() => this.setState({active: 'map'})}
          />
          <BottomNavigation.Action
            key="list"
            icon="menu"
            label="List View"
            onPress={() => this.setState({active: 'list'})}
          />
          <BottomNavigation.Action
            key="history"
            icon="history"
            label="History"
            onPress={() => this.setState({active: 'history'})}
          />
          <BottomNavigation.Action
            key="settings"
            icon="settings"
            label="Settings"
            onPress={() => this.setState({active: 'settings'})}
          />
        </BottomNavigation>

      </View>
    );
  }
}

function statusToText(code) {
  switch (code) {
    case 0: return 'Not Home';
    case 1: return 'Home';
    case 2: return 'Not Interested';
    case 3: return 'Moved';
    default: return 'unknown';
  }
}

function timeFormat(epoch) {
  let date = new Date(epoch);
  return date.toLocaleDateString('en-us')+" "+date.toLocaleTimeString('en-us');
}

const Unit = props => (
  <View key={props.unit.name} style={{padding: 10}}>
    <TouchableOpacity
      style={{flexDirection: 'row', alignItems: 'center'}}
      onPress={() => {
        props.refer.setState({ isKnockMenuVisible: true, currentUnit: props.unit });
      }}>
      <Icon name={(props.color === "red" ? "ban" : "address-book")} size={40} color={props.color} style={{margin: 5}} />
      <Text>Unit {(props.unknown?"Unknown":props.unit.name)} - {props.refer.getLastVisit(props.unit)}</Text>
    </TouchableOpacity>
  </View>
);

const TurfStats = props => (
  <View>
    {props.loading&&
    <ActivityIndicator size="large" />
    }
    {!props.loading&&
    <View style={{padding: 10}}>
      <Text>{JSON.stringify(props.data.stats)}</Text>
    </View>
    }
  </View>
);

const History = props => (
  <ScrollView>
    {props.loading&&
    <ActivityIndicator size="large" />
    }
    {!props.loading&&
    <View style={{padding: 10}}>
      <Text>{(props.data.length?'Loaded '+props.data.length+' historical actions:':'No history to view')}</Text>
    </View>
    }
    <FlatList
      scrollEnabled={false}
      data={props.data}
      keyExtractor={item => ""+item.id}
      renderItem={({item}) => (
        <View key={item.id}>
          <Divider />
          <TouchableOpacity style={{marginTop: 10, marginBottom: 10}}
            onPress={() => props.onPress({
              longitude: item.address.position.x,
              latitude: item.address.position.y,
            })}>
            <View style={{flexDirection: 'row'}}>
              <View style={{width: 100, alignItems: 'center'}}>
                <Image source={{ uri: item.volunteer.avatar }} style={{height: 50, width: 50, padding: 10, borderRadius: 20}} />
                <Text>{item.volunteer.name}</Text>
              </View>
              <View>
                <Text>Date: {timeFormat(item.datetime)}</Text>
                <Text>Address: {item.address.street}</Text>
                <Text>Status: {statusToText(item.status)}</Text>
                <Text>Contact: {(item.person?item.person.name:'N/A')}</Text>
              </View>
            </View>
          </TouchableOpacity>
        </View>
      )}
    />
  </ScrollView>
);

const iconStyles = {
  justifyContent: 'center',
  borderRadius: 10,
  padding: 10,
};

const displayNone = {
  height: 0,
  maxHeight: 0,
  opacity: 0,
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFF',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconContainer: {
    backgroundColor: '#ffffff', width: 65, height: 65, borderRadius: 65,
    borderWidth: 2, borderColor: '#000000',
    alignItems: 'center', justifyContent: 'center', margin: 2.5,
  },
  turfInfoContainer: {
    backgroundColor: '#ffffff', width: 125, height: 45,
    borderWidth: 2, borderColor: '#000000',
    alignItems: 'center', justifyContent: 'center', margin: 2.5,
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  button: {
    width: 300,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 5,
    backgroundColor: '#d7d7d7',
  },
  buttonText: {
    fontSize: 18,
    color: 'white',
    alignSelf: 'center'
  },
  addButton: {
    height: 36,
    backgroundColor: '#48BBEC',
    borderColor: '#48BBEC',
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: 10,
    alignSelf: 'stretch',
    justifyContent: 'center'
  },
  buttonContainer: {
    flexDirection: 'row',
    marginVertical: 5,
    backgroundColor: 'transparent',
  },
});