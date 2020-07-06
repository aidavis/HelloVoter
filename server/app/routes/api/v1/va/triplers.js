import { Router } from 'express';
import neo4j from 'neo4j-driver';
import stringFormat from 'string-format';
import { v4 as uuidv4 } from 'uuid';

import phoneFormat from '../../../../lib/phone';
import { ov_config } from '../../../../lib/ov_config';
import triplersSvc from '../../../../services/triplers';

import {
  _204, _400, _401, _403, _404, _500, geoCode, validateEmpty, validatePhone, validateEmail
} from '../../../../lib/utils';

import { serializeTripler, serializeNeo4JTripler } from './serializers';

import sms from '../../../../lib/sms';


async function createTripler(req, res) {
  let new_tripler = null

  try {
    if (!validateEmpty(req.body, ['first_name', 'phone', 'address'])) {
      return _400(res, "Invalid payload, tripler cannot be created");
    }

    if (!validatePhone(req.body.phone)) {
      return _400(res, "Invalid phone");
    }

    if (req.body.email && !validateEmail(req.body.email)) {
      return _400(res, "Invalid email"); 
    }

    let existing_tripler = await req.neode.first('Tripler', 'phone', phoneFormat(req.body.phone));
    if (existing_tripler) {
      return _400(res, "Tripler with this phone already exists");
    }

    let coordinates = await geoCode(req.body.address);
    if (coordinates === null) {
      return _400(res, "Invalid address, tripler cannot be created");
    }

    const obj = {
      id: uuidv4(),
      first_name: req.body.first_name,
      last_name: req.body.last_name || null,
      phone: phoneFormat(req.body.phone),
      email: req.body.email || null,
      address: JSON.stringify(req.body.address),
      triplees: !req.body.triplees ? null : JSON.stringify(req.body.triplees),
      location: {
        latitude: parseFloat(coordinates.latitude, 10),
        longitude: parseFloat(coordinates.longitude, 10)
      },
      status: 'unconfirmed'
    }

    new_tripler = await req.neode.create('Tripler', obj);
  } catch(err) {
    req.logger.error("Unhandled error in %s: %s", req.url, err);
    return _500(res, 'Unable to create tripler');
  }
  return res.json(serializeTripler(new_tripler));
}

async function fetchAllTriplers(req, res) {
  const collection = await req.neode.model('Tripler').all();
  let models = [];
  for (var index = 0; index < collection.length; index++) {
    let entry = collection.get(index);
    models.push(serializeTripler(entry))
  }
  return res.json(models);
}

async function suggestTriplers(req, res) {
  let collection = await req.neode.query()
    .match('a', 'Ambassador')
    .where('a.id', req.user.get('id'))
    .match('t', 'Tripler')
    .whereRaw('NOT (a)-[:CLAIMS]->(t)')
    .whereRaw('distance(t.location, a.location) <= 10000') // distance in meters (10km)
    .return('t')
    .execute()

  let models = [];
  for (var index = 0; index < collection.records.length; index++) {
    let entry = collection.records[index]._fields[0].properties;
    models.push(serializeNeo4JTripler(entry));
  }
  return res.json(models);
}

async function fetchTripler(req, res) {
  let ambassador = req.user;
  let tripler = null;
  ambassador.get('claims').forEach((entry) => { if (entry.otherNode().get('id') === req.params.triplerId) { tripler = entry.otherNode() } } );
  
  if (!tripler) {
    return _400(res, "Invalid triper id");
  }
  return res.json(serializeTripler(tripler));
}

async function updateTripler(req, res) {
  let found = null;
  found = await req.neode.first('Tripler', 'id', req.params.triplerId);
  if (!found) return _404(res, "Tripler not found");

  if (req.body.phone) {
    if (!validatePhone(req.body.phone)) {
      return _400(res, "Invalid phone");
    }

    let existing_tripler = await req.neode.first('Tripler', 'phone', phoneFormat(req.body.phone));
    if(existing_tripler && existing_tripler.get('id') !== found.get('id')) {
      return _400(res, "Tripler with this phone number already exists");
    }
  }

  if (req.body.email && !validateEmail(req.body.email)) {
    return _400(res, "Invalid email"); 
  }

  let whitelistedAttrs = ['first_name', 'last_name', 'date_of_birth', 'email', 'status'];

  let json = {};
  for (let prop in req.body) {
    if (whitelistedAttrs.indexOf(prop) !== -1) {
      json[prop] = req.body[prop];
    }
  }

  if (req.body.phone) {
    json.phone = phoneFormat(req.body.phone);
  }

  if (req.body.address) {
    let coordinates = await geoCode(req.body.address);
    if (coordinates === null) {
      return _400(res, "Invalid address, tripler cannot be updated");
    }
    json.address = JSON.stringify(req.body.address);
    json.location = new neo4j.types.Point(4326, // WGS 84 2D
                                           parseFloat(coordinates.longitude, 10),
                                           parseFloat(coordinates.latitude, 10));
  }

  if (req.body.triplees) {
    json.triplees = JSON.stringify(req.body.triplees);
  }

  let updated = await found.update(json);
  return res.json(serializeTripler(updated));
}

async function startTriplerConfirmation(req, res) {
  let ambassador = req.user;
  let tripler = null;
  ambassador.get('claims').forEach((entry) => { if (entry.otherNode().get('id') === req.params.triplerId) { tripler = entry.otherNode() } } );
  
  if (!tripler) {
    return _400(res, "Invalid triper id");
  }
  else if (tripler.get('status') !== 'unconfirmed') {
    return _400(res, "Invalid status, cannot proceed")
  }

  let triplees = req.body.triplees;
  if (!triplees || triplees.length !== 3) {
    return _400(res, 'Insufficient triplees, cannot start confirmation')
  }

  if (req.body.phone && !validatePhone(req.body.phone)) {
    return _400(res, "Invalid phone");
  }

  let triplerPhone = req.body.phone ? phoneFormat(req.body.phone): tripler.get('phone');

  try {
    await sms(triplerPhone, stringFormat(process.env.TRIPLER_CONFIRMATION_MESSAGE, 
                                    {
                                      ambassador_first_name: ambassador.get('first_name'),
                                      ambassador_last_name: ambassador.get('last_name') || '',
                                      organization_name: process.env.ORGANIZATION_NAME,
                                      tripler: tripler.get('first_name'), 
                                      triplee_1: triplees[0],
                                      triplee_2: triplees[1],
                                      triplee_3: triplees[2]
                                    }));
  } catch (err) {
    req.logger.error("Unhandled error in %s: %s", req.url, err);
    return _500(res, 'Error sending confirmation sms to the tripler');
  }
  await tripler.update({ triplees: JSON.stringify(triplees), status: 'pending', phone: triplerPhone });
  return _204(res);
}

async function remindTripler(req, res) {
  let ambassador = req.user;
  let tripler = null;
  ambassador.get('claims').forEach((entry) => { if (entry.otherNode().get('id') === req.params.triplerId) { tripler = entry.otherNode() } } );
  
  if (!tripler) {
    return _400(res, "Invalid triper id");
  }
  else if (tripler.get('status') !== 'pending') {
    return _400(res, "Invalid status, cannot proceed")
  }

  let new_phone = req.body.phone;
  if (new_phone) {
    if (!validatePhone(req.body.phone)) {
      return _400(res, "Invalid phone");
    }
    
    await tripler.update({ phone: new_phone });
  }

  let triplees = JSON.parse(tripler.get('triplees'));

  try {
    await sms(tripler.get('phone'), stringFormat(process.env.TRIPLER_REMINDER_MESSAGE,
                                    {
                                      ambassador_first_name: ambassador.get('first_name'),
                                      ambassador_last_name: ambassador.get('last_name') || '',
                                      organization_name: process.env.ORGANIZATION_NAME,
                                      tripler: tripler.get('first_name'),
                                      triplee_1: triplees[0],
                                      triplee_2: triplees[1],
                                      triplee_3: triplees[2]
                                    }));
  } catch (err) {
    req.logger.error("Unhandled error in %s: %s", req.url, err);
    return _500(res, 'Error sending reminder sms to the tripler');
  }

  return _204(res);
}

async function confirmTripler(req, res) {
  let tripler = await triplersSvc.findById(req.params.triplerId);
  
  if (!tripler) {
    return _404(res, "Invalid tripler");
  }

  if (tripler.get('status') !== 'pending') {
    return _400(res, "Invalid status, cannot confirm")
  }

  try {
    await triplersSvc.confirmTripler(req.params.triplerId);
  } catch(err) {
    req.logger.error("Unhandled error in %s: %s", req.url, err);
    return _500(res, 'Error confirming a tripler'); 
  }
  return _204(res);
}

async function deleteTripler(req, res) {
  let tripler = await triplersSvc.findById(req.params.triplerId);
  
  if (!tripler) {
    return _404(res, "Invalid tripler");
  }

  tripler.delete();
  return _204(res);
}

module.exports = Router({mergeParams: true})
.post('/triplers', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  if (!req.user.get('admin')) return _403(res, "Permission denied.");;
  return createTripler(req, res);
})
.put('/triplers/:triplerId', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  if (!req.user.get('admin')) return _403(res, "Permission denied.");;
  return updateTripler(req, res);
})
.put('/triplers/:triplerId/confirm', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  if (!req.user.get('admin')) return _403(res, "Permission denied.");;
  return confirmTripler(req, res);
})
.get('/triplers', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  // temporarily removing admin restriction so Tomaz can pretend it is /suggest-triplers
  // if (!req.user.get('admin')) return _403(res, "Permission denied.");;
  return fetchAllTriplers(req, res);
})
.delete('/triplers/:triplerId', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  if (!req.user.get('admin')) return _403(res, "Permission denied.");;
  return deleteTripler(req, res);
})

.get('/suggest-triplers', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  return suggestTriplers(req, res);
})
.put('/triplers/:triplerId/start-confirm', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  return startTriplerConfirmation(req, res);
})
.put('/triplers/:triplerId/remind', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  return remindTripler(req, res);
})
.get('/triplers/:triplerId', (req, res) => {
  if (!req.user) return _401(res, 'Permission denied.');
  return fetchTripler(req, res);
})