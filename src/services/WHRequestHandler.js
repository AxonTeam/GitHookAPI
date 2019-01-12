'use strict';

const superagent = require('superagent');

const { Logger } = require('../utils/Logger');

/**
 * Handle all requests made to discord webhooks
 *
 * @author KhaaZ
 *
 * @class WHRequestHandler
 */
class WHRequestHandler {
    /**
     * webhook =
     *  {
     *      name: 'WH name',
     *      id: 'WH id'
     *      token: 'WH token'
     *  }
     *
     * req =
     *  {
     *      headers: headers (superagent set)
     *      body: body (superagent send)
     *  }
     */
    constructor() {
        this._baseURL = 'https://discordapp.com/api/v6';

        /** Collections for handling rate-limits and queue */
        this.rateLimitCollection = new Map();
        this.queueCollection = new Map();
    }

    get baseURL() {
        return this._baseURL;
    }
    /**
     * Requester method to post request to a discord webhook
     *
     * The webhook Object contains information about the webhook to request
     * The req Object contains req.headers + req.body.
     *
     * @param {Object} webhook -Object containing the webhook id and token {name: webhook.name, id: webhook.id, webhook.token }
     * @param {Object} req -Object containing req.headers and req.body from root { headers: req.headers, body: req.body }
     * @param {Boolean} type - true: request github endpoint | false: request regular webhook endpoint
     * @returns {Promise}
     * @memberof WHRequestHandler
     */
    async request(webhook, req, type = false) {
        const { name, id, token } = webhook;
        const { headers, body } = req;
        const endpoint = `${id}/${token}`;
        const requestURL = `${this._baseURL}/${id}/${token}/${(type === true) ? 'github' : ''}`;

        const queue = this.queueCollection.get(endpoint) || Promise.resolve();
        const request = queue.then(() => this.conditionalsHandler(endpoint, requestURL, 'post', headers, {}, body, name));
        const tail = request.catch(() => {}); // eslint-disable-line
        this.queueCollection.set(endpoint, tail);

        try {
            return await request;
        } finally {
            if (this.queueCollection.get(endpoint) === tail) {
                this.queueCollection.delete(endpoint);
            }
        }
    }

    /**
     * Makes API requests using superagent
     *
     * @param {String} requestURL
     * @param {String} method
     * @param {Object} headers
     * @param {Object} queryParams
     * @param {Object} fields
     * @returns {Promise}
     */

    superagent(requestURL, method, headers, queryParams, fields) {
        return superagent(method, requestURL)
            .set(headers || {})
            .query(queryParams || {})
            .send(fields);
    }

    /**
     * Sets or edits Cache to handle rate-limits
     *
     * @param {String} endpoint
     * @param {Object} header
     * @param {Boolean} edit
     * @param {Number} statusCode
     * @param {String} name
     * @returns {void}
     */

    setOrEditRateLimitCache(endpoint, header, edit, statusCode, name) {
        const discordHeader = Number(header['x-ratelimit-remaining']);

        if ((discordHeader === 0) || (statusCode === 429)) {
            const discordResetTime = Number(header['x-ratelimit-reset']) * 1000;
            const discordRetryAfter = Number(header['retry-after']) + Date.now();
            const timestamp = discordResetTime ^ ((discordResetTime ^ discordRetryAfter) & -(discordResetTime < discordRetryAfter));

            Logger.debug(`${(statusCode !== 429) ? 'Hitting Rate-limit for' : 'Already ratelimited'}: ${name}.`);

            if (header['x-ratelimit-global']) {
                this.rateLimitCollection.set('global', discordRetryAfter);
                return;
            } else {
                this.rateLimitCollection.set(endpoint, timestamp);
                return;
            }
        } else if (edit === true) {
            this.rateLimitCollection.delete(endpoint);
            return;
        }
    }

    /**
     * Handles rate-limit conditions
     *
     * @param {String} endpoint
     * @param {String} requestURL
     * @param {String} method
     * @param {Object} headers
     * @param {Object} query
     * @param {Object} body
     * @param {String} name
     * @returns {Promise}
     */
    async conditionalsHandler(endpoint, requestURL, method, headers, query, body, name) {
        try {
            if ((this.rateLimitCollection.has(endpoint) === false) && (this.rateLimitCollection.has('global') === false)) {
                const response = await this.superagent(requestURL, method, headers, query, body);
                this.setOrEditRateLimitCache(endpoint, response.header, false, response.status, name);
                this.queueCollection.delete(endpoint);
                Logger.verbose(`Posted to ${name}.`);
                return response;
            } else {
                const endpointTimestamp = this.rateLimitCollection.get(endpoint) || 0;
                const globalTimestamp = this.rateLimitCollection.get('global') || 0;
                const timestamp = endpointTimestamp ^ ((endpointTimestamp ^ globalTimestamp) & -(endpointTimestamp < globalTimestamp));

                if (timestamp >= Date.now()) {
                    const response = new Promise((resolve, reject) => {
                        setTimeout(async() => {
                            try {
                                const response = await this.superagent(requestURL, method, headers, query, body);
                                resolve(response);
                                this.setOrEditRateLimitCache(endpoint, response.header, true, response.status, name);
                            } catch (error) {
                                if (error.status === 429) { // Rate-Limited error
                                    Logger.debug(`Already RateLimited: ${name} => delaying...`);
                                    this.setOrEditRateLimitCache(endpoint, error.response.header, false, 429, name);
                                    this.conditionalsHandler(endpoint, requestURL, method, headers, query, body)
                                        .then(response => resolve(response))
                                        .catch(error => reject(error));
                                } else {
                                    reject(error);
                                }
                            }
                        }, timestamp - Date.now());
                    });
                    Logger.verbose(`Posted to ${name}.`);
                    return response;
                } else {
                    const response = await this.superagent(requestURL, method, headers, query, body);
                    this.setOrEditRateLimitCache(endpoint, response.header, true, response.status, name);
                    Logger.verbose(`Posted to ${name}.`);
                    return response;
                }
            }
        } catch (error) {
            if (error.status === 429) { // Rate-Limited error
                Logger.debug(`Already RateLimited: ${name} => delaying...`);
                this.setOrEditRateLimitCache(endpoint, error.response.header, false, 429);
                const response = new Promise((resolve, reject) => {
                    setTimeout(() => { // https://stackoverflow.com/a/20999077/10901309
                        this.conditionalsHandler(endpoint, requestURL, method, headers, query, body)
                            .then(response => resolve(response))
                            .catch(error => reject(error));
                    }, 0);
                });

                return response;
            } else {
                Logger.fatal(`Couldn't post to ${name}.\n${error}`);
                throw error;
            }
        }
    }
}

exports.WHRequestHandler = new WHRequestHandler();
