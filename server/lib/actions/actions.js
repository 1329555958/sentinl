/*
 *   Copyright 2016, Lorenzo Mangani (lorenzo.mangani@gmail.com)
 *   Copyright 2015, Rao Chenlin (rao.chenlin@gmail.com)
 *
 *   This file is part of Sentinl (http://github.com/sirensolutions/sentinl)
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import _ from 'lodash';
import {assign} from 'lodash';
import url from 'url';
import Promise from 'bluebird';
import moment from 'moment';
import mustache from 'mustache';
import getConfiguration from '../get_configuration';
import getElasticsearchClient from '../get_elasticsearch_client';
import logHistory from '../log_history';
import Email from './helpers/email';
import Log from '../log';

// actions
import reportAction from './report_action';

export default function (server, actions, payload, task) {

  const config = getConfiguration(server);
  const log = new Log(config.app_name, server, 'action');
  const client = getElasticsearchClient(server, config);

  /* ES Indexing Functions */
  var esHistory = function (args) {
    args.server = server;
    args.client = client;
    args.config = config;
    return logHistory(args);
  };


  /* Email Settings */
  const { user, password, host, ssl, timeout } = config.settings.email;
  const email = new Email({
    user,
    password,
    host,
    ssl,
    timeout
  });

  /* Slack Settings */
  var slack;
  if (config.settings.slack.active) {
    var Slack = require('node-slack');
    slack = new Slack(config.settings.slack.hook);
  }


  /* Debounce Function, returns true if throttled */
  var getDuration = require('sum-time');
  var debounce = function (id, period) {
    var duration = getDuration(period);

    var isInThrottlePeriod = function (id, now, duration) {
      return (now - server.sentinlStore.actions[id]) < duration;
    };

    if (duration) {
      var justNow = new Date().getTime();

      if (!_.has(server.sentinlStore, 'actions')) {
        server.sentinlStore.actions = {};
      }

      if (!_.has(server.sentinlStore.actions, id) || !isInThrottlePeriod(id, justNow, duration)) {
        server.sentinlStore.actions[id] = justNow;
        return false;
      }

      // throttle action
      return true;
    } else {
      return false;
    }
  };


  /* Loop Actions */
  _.forEach(actions, function (action, actionName) {
    log.debug(`processing action: ${actionName}`);

    /* ***************************************************************************** */
    /*
    *   "console" : {
    *      "priority" : "DEBUG",
    *      "message" : "Average {{payload.aggregations.avg.value}}",
    *      "save_payload" : false
    *    }
    */

    var priority;
    var formatterConsole;
    var message;
    if (_.has(action, 'console')) {
      priority = action.console.priority ? action.console.priority : 'INFO';
      formatterConsole = action.console.message ? action.console.message : '{{ payload }}';
      message = mustache.render(formatterConsole, {payload: payload});
      log.debug('console payload', payload);
      esHistory({
        title: task._source.title,
        actionType: actionName,
        message,
        level: priority,
        payload: !action.console.save_payload ? {} : payload,
        report: false
      });
    }

    /* ***************************************************************************** */
    /*
    /* Throttle Action based on 'throttle_period' optional parameter
    /* "throttle_period": "5m"
    /*
    /* ***************************************************************************** */
    if (_.has(action, 'throttle_period')) {
      const id = `${task._id}_${actionName}`;
      if (debounce(id, action.throttle_period)) {
        log.info(`action throttled, watcher id: ${task._id}, action name: ${actionName}`);
        esHistory({
          title: task._source.title,
          actionType: actionName,
          message: `Action Throttled for ${action.throttle_period}`,
          level: priority,
          payload: {}
        });
        return;
      }
    }

    /* ***************************************************************************** */
    /*
    *   "email" : {
    *      "to" : "root@localhost",
    *      "from" : "sentinl@localhost",
    *      "subject" : "Alarm Title",
    *      "priority" : "high",
    *      "body" : "Series Alarm {{ payload._id}}: {{payload.hits.total}}",
    *      "stateless" : false,
    *      "save_payload" : false
    *	    }
    */

    var formatterSubject;
    var formatterBody;
    var subject;
    var text;
    if (_.has(action, 'email')) {
      formatterSubject = action.email.subject ? action.email.subject : 'SENTINL: ' + actionName;
      formatterBody = action.email.body ? action.email.body : 'Series Alarm {{ payload._id}}: {{payload.hits.total}}';
      subject = mustache.render(formatterSubject, {payload: payload});
      text = mustache.render(formatterBody, {payload: payload});
      priority = action.email.priority ? action.email.priority : 'INFO';
      log.debug(`subject: ${subject}, body: ${text}`);

      if (!email || !config.settings.email.active) {
        log.warning('email delivery disabled');
      }
      else {
        log.debug('delivering to email server');
        email.send({
          text,
          from: action.email.from,
          to: action.email.to,
          subject
        }).then(function (message) {
          log.debug(`email sent, watcher: ${task._id}, message: ${message}`);
        }).catch(function (error) {
          log.error(`fail to send email, watcher: ${task._id}, ${error}`);
        });
      }
      if (!action.email.stateless) {
        // Log Event
        esHistory({
          title: task._source.title,
          actionType: actionName,
          message: text,
          level: priority,
          payload: !action.email.save_payload ? {} : payload,
          report: false
        });
      }
    }


    /* ***************************************************************************** */
    /*
    *   "email_html" : {
    *      "to" : "root@localhost",
    *      "from" : "sentinl@localhost",
    *      "subject" : "Alarm Title",
    *      "priority" : "high",
    *      "body" : "Series Alarm {{ payload._id}}: {{payload.hits.total}}",
    *      "html" : "<p>Series Alarm {{ payload._id}}: {{payload.hits.total}}</p>",
    *      "stateless" : false,
    *      "save_payload" : false
    *	    }
    */
    var html;
    if (_.has(action, 'email_html')) {
      formatterSubject = action.email_html.subject ? action.email_html.subject : 'SENTINL: ' + actionName;
      formatterBody = action.email_html.body ? action.email_html.body : 'Series Alarm {{ payload._id}}: {{payload.hits.total}}';
      formatterConsole = action.email_html.html ? action.email_html.html : '<p>Series Alarm {{ payload._id}}: {{payload.hits.total}}</p>';
      subject = mustache.render(formatterSubject, {payload: payload});
      text = mustache.render(formatterBody, {payload: payload});
      html = mustache.render(formatterConsole, {payload: payload});
      priority = action.email_html.priority ? action.email_html.priority : 'INFO';
      log.debug(`subject: ${subject}, body: ${text}, HTML: ${html}`);

      if (!email || !config.settings.email.active) {
        log.warning('email html delivery disabled');
      }
      else {
        log.debug('delivering to email server');
        email.send({
          text,
          from: action.email_html.from,
          to: action.email_html.to,
          subject,
          attachment: [
            {
              data: html,
              alternative: true
            }
          ]
        }).then(function (message) {
          log.debug(`email sent, watcher: ${task._id}, message: ${message}`);
        }).catch(function (error) {
          log.error(`fail to send email, watcher: ${task._id}, ${error}`);
        });
      }

      if (!action.email_html.stateless) {
        // Log Event
        esHistory({
          title: task._source.title,
          actionType: actionName,
          message: text,
          level: priority,
          payload: !action.email_html.save_payload ? {} : payload,
          report: false
        });
      }
    }

    /* ***************************************************************************** */
    /*
    *   "report" : {
    *      "to" : "root@localhost",
    *      "from" : "sentinl@localhost",
    *      "subject" : "Report Title",
    *      "priority" : "high",
    *      "body" : "Series Report {{ payload._id}}: {{payload.hits.total}}",
    *      "snapshot" : {
    *      		"res" : "1280,900",
    *         "url" : "http://127.0.0.1/app/kibana#/dashboard/Alerts",
    *         "path" : "/tmp/",
    *         "params" : {
    *      				"username" : "username",
    *      				"password" : "password",
    *      				"delay" : 15,
    *             "crop" : false
    *         }
    *       },
    *      "stateless" : false
    *    }
    */

    if (_.has(action, 'report')) {
      return reportAction(server, email, task, action, actionName, payload).then(function (file) {
        if (!action.report.stateless) {
          esHistory({
            title: task._source.title,
            actionType: actionName,
            message: text,
            level: priority,
            payload: {},
            report: true,
            object: file
          });
        }
        return null;
      }).catch(function (error) {
        log.error(`fail to report, ${error}`);
        if (!action.report.stateless) {
          esHistory({
            title: task._source.title,
            actionType: actionName,
            message: error
          });
        }
      });
    }

    /* ***************************************************************************** */
    /*
    *   "slack" : {
    *      "channel": '#<channel>',
    *      "message" : "Series Alarm {{ payload._id}}: {{payload.hits.total}}",
    *      "stateless" : false,
    *      "save_payload" : false
    *    }
    */

    if (_.has(action, 'slack')) {
      let formatter;
      formatter = action.slack.message ? action.slack.message : 'Series Alarm {{ payload._id}}: {{payload.hits.total}}';
      message = mustache.render(formatter, {payload: payload});
      priority = action.slack.priority ? action.slack.priority : 'INFO';
      log.debug(`webhook to #${action.slack.channel}, message: ${message}`);

      if (!slack || !config.settings.slack.active) {
        log.warning('slack message delivery disabled');
      }
      else {
        try {
          slack.send({
            text: message,
            channel: action.slack.channel,
            username: config.settings.slack.username
          });
        } catch (err) {
          log.error(`fail sending to: ${config.settings.slack.hook}`);
        }
      }

      if (!action.slack.stateless) {
        // Log Event
        esHistory({
          title: task._source.title,
          actionType: actionName,
          message,
          level: priority,
          payload: !action.slack.save_payload ? {} : payload,
          report: false
        });
      }
    }

    /* ***************************************************************************** */
    /*
    *   "webhook" : {
    *      "method" : "POST",
    *      "host" : "remote.server",
    *      "port" : 9200,
    *      "path": "/{{payload.watcher_id}}",
    *      "body" : "{{payload.watcher_id}}:{{payload.hits.total}}",
    *      "use_https" : false,
    *      "stateless" : false,
    *      "save_payload" : false,
    *      "headers": {'Content-Type': 'text/plain'},
    *    }
    */

    if (_.has(action, 'webhook')) {
      const http = action.webhook.use_https ? require('https') : require('http');
      let options;
      let req;

      options = {
        hostname: action.webhook.host ? action.webhook.host : 'localhost',
        port: action.webhook.port ? action.webhook.port : 80,
        path: action.webhook.path ? action.webhook.path : '/',
        method: action.webhook.method ? action.webhook.method : 'GET',
        headers: action.webhook.headers ? action.webhook.headers : {},
        auth: action.webhook.auth ? action.webhook.auth : undefined
      };

      let dataToWrite = action.webhook.body ? mustache.render(action.webhook.body, {payload: payload}) : action.webhook.params;
      if (dataToWrite) {
        options.headers['Content-Length'] = Buffer.byteLength(dataToWrite);
      }

      // Log Alarm Event
      if (action.webhook.create_alert && payload.constructor === Object && Object.keys(payload).length) {
        if (!action.webhook.stateless) {
          esHistory({
            title: task._source.title,
            actionType: actionName,
            message: action.webhook.message,
            level: action.webhook.priority,
            payload: !action.webhook.save_payload ? {} : payload,
            report: false
          });
        }
      }

      req = http.request(options, function (res) {
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
          log.debug(`webhook response: ${chunk}`);
        });
      });

      req.on('error', function (e) {
        log.error(`fail to ship webhook: ${e.message}`);
      });
      if (dataToWrite) {
        req.write(dataToWrite);
      }
      req.end();
    }

    /* ***************************************************************************** */
    /*
    *   "elastic" : {
    *      "priority" : "DEBUG",
    *      "message" : "Avg {{payload.aggregations.avg.value}} measurements in 5 minutes"
    *      "save_payload" : false,
    *    }
    */

    if (_.has(action, 'elastic')) {
      let esMessage;
      let esFormatter;
      esFormatter = action.local.message ? action.local.message : '{{ payload }}';
      esMessage = mustache.render(esFormatter, {payload: payload});
      priority = action.local.priority ? action.local.priority : 'INFO';
      log.debug(`logged message to elastic: ${esMessage}`);
      // Log Event
      esHistory({
        title: task._source.title,
        actionType: actionName,
        message: esMessage,
        level: priority,
        payload: !action.local.save_payload ? {} : payload,
        report: false
      });
    }


    /* ***************************************************************************** */
    /*      you must set your api key in config.settings.pushapps.api_key
    mandatory parameters are text and at least on element in platforms array, see https://docs.pushapps.mobi/docs/notifications-create-notification for more info
    *   "pushapps" : {
    *      "platforms" : [ "android" , "ios", "web", "fb-messenger", "whatsapp"],
    *      "tags" : [ "<optional tag from PushApps>"],
    *      "campaign_id" : "<optional campaign id from PushApps>",
    *      "text" : "Series Alarm {{ payload._id}}: {{payload.hits.total}}",
    *      "url" : "<optional url to present>",
    *      "image_url" : "<optional image url for the notification or message>"
    *    }
    */

    if (_.has(action, 'pushapps')) {
      const querystring = require('querystring');
      const http = require('http');
      let options;
      let req;

      options = {
        hostname: 'https://api.pushapps.mobi/v1',
        port: 443,
        path: '/notifications',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': config.settings.pushapps.api_key
        }
      };

      var postData = querystring.stringify({
        text: action.text,
        platforms: action.platform,
        tags: action.tags,
        campaign_id: action.campaign_id,
        url: action.url,
        image_url: action.image_url
      });

      req = http.request(options, function (res) {
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
          log.debug(`pushapps response: ${chunk}`);
        });
      });

      req.on('error', function (e) {
        log.error(`fail to create a PushApps notification: ${e}`);
      });
      req.write(postData);
      req.end();
    }
  });
}

