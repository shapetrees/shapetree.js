/**
 * This module provides an implementation of the ecosystem API:
 * * createSystemHierarchy - create a hierarchy with /apps, /cache and /shared
 * * indexInstalledShapeTree - assert that a local URL is an instance of a ShapeTree
 * * unindexInstalledShapeTree - remove assertion that a local URL is an instance of a ShapeTree
 * * reuseShapeTree - look in an LDPC for instances of a footprint
 * * registerInstance - register a new ShapeTree instance
 * * parseInstatiationPayload - parse payload when planting a ShapeTree
 * @module SimpleApps
 */

/**
 * @typedef ContainerSpec
 * @type {object}
 * @property {string} path - resource path from root of ShapeTree instance.
 * @property {string} title - title of this Container.
 * @property {ContainerSpec[]} [children] - nested children of this ldp:Container.
 * @property {Container} [container] - container object for this ldp:Container in the instance.
 */

/* SimpleApps
 *
 * stores ShapeTree indexes in parent containers e.g. /Public or /SharedData
 */

const Fs = require('fs');
const Fetch = require('node-fetch');
const Log = require('debug')('		simpleApps');
const Details = Log.extend('details');
const Errors = require('../lib/rdf-errors');
const Mutex = require('../lib/mutex');
const Prefixes = require('../lib/prefixes');
const { DataFactory } = require("n3");
const { namedNode, literal, defaultGraph, quad } = DataFactory;

class FakeResponse {
  constructor (url, headers, text) {
    this._url = url;
    this.headers = headers;
    this._text = text;
    this.ok = true;
  }
  text () { return Promise.resolve(this._text); }
};

/** a simple ecosystem
 * @param {Storage} storage - instance of Storage API
 * @param {ShapeTree} shapeTree - ShapeTree library instance
 * @param rdfInterface - instance of RDF Serializatin API
*/
class SimpleApps {
  constructor (storage, shapeTree, rdfInterface) {
    this.storage = storage;
    this.shapeTree = shapeTree;
    this._rdfInterface = rdfInterface;
    this._mutex = new Mutex();
  }

  /** recursively create a container and any children containers.
   *  @param {URL} baseUrl - root of tree, e.g. http://localhost/
   *  @param {object} config - configuration object typically parsed from a config file
   *  @example <caption>Create a resource hierarchy with /Cache, /Data and /Apps</caption>
   *  // returns {...}
   *  const hierarchy = await app.createSystemHierarchy({
   *    "cache": "Cache",
   *    "shared": "Data",
   *    "apps": "Apps"
   *  })
   *  @returns {SimpleApps.ContainerSpec} - a ContainerSpec populated with Container objects
   */
  createSystemHierarchy (baseUrl, config) {
    this.baseUrl = baseUrl;
    this.appsUrl = new URL(config.apps + '/', baseUrl);
    this.cacheUrl = new URL(config.cache + '/', baseUrl);
    const _SimpleApps = this;
    let containerHierarchy =
        {path: '/', title: "DocRoot Container", children: [
          {path: config.apps + '/', title: "Applications Container"},
          {path: config.cache + '/', title: "Cache Container"},
          {path: config.shared + '/', title: "Shared Data Container"},
        ]};
    return createContainers(containerHierarchy, baseUrl);

    /** recursively create a container and any children containers.
     * @param {PropertiesHash} foo - \{path, title, children: [...]\}
     * @param spec - \{path, title, children: [...]\}
     * @param path - relative path from parent, e.g. ./ or ./Apps
     * @param title - text for the dc:title property
     * @param children - option list of specs of child containers
     * @param parentUrl - URL of parent container, e.g. URL('http://localhost/')
     */
    async function createContainers (spec, parentUrl)  {
      const container = await new _SimpleApps.shapeTree.Container(new URL(spec.path, parentUrl), spec.title).ready;
      spec.container = container; // in case someone needs them later.
      if (spec.children) {
        await Promise.all(spec.children.map(async child => {
          await createContainers(child, container.url);
          container.addMember(new URL(child.path, parentUrl).href, null);
        }));
        await container.write();
      }
      return spec;
    }
  }

  /** indexInstalledShapeTree - assert that instanceUrl is an instance of shapeTreeUrl
   * @param {ShapeTree.ManagedContainer} parent
   * @param {URL} instanceUrl
   * @param {URL} shapeTreeUrl
   */
  indexInstalledShapeTree (parent, instanceUrl, shapeTreeUrl) {
    parent.graph.addQuad(namedNode(instanceUrl.href), namedNode(Prefixes.tree + 'shapeTreeRoot'), namedNode(shapeTreeUrl.href));
    parent.prefixes['tree'] = Prefixes.tree;
  }

  /** unindexInstalledShapeTree - remove assertion that instanceUrl is an instance of shapeTreeUrl
   * @param {ShapeTree.ManagedContainer} parent
   * @param {URL} instanceUrl
   * @param {URL} shapeTreeUrl
   */
  unindexInstalledShapeTree (parent, instanceUrl, shapeTreeUrl) {
    parent.graph.removeQuad(namedNode(instanceUrl.href), namedNode(Prefixes.tree + 'shapeTreeRoot'), namedNode(shapeTreeUrl.href));
  }

  /** reuseShapeTree - look in an LDPC for instances of a footprint
   * @param {ShapeTree.ManagedContainer} parent
   * @param {ShapeTree.RemoteShapeTree} shapeTreeUrl
   */
  reuseShapeTree (parent, shapeTreeUrl) {
    const q = this._rdfInterface.zeroOrOne(parent.graph, null, namedNode(Prefixes.tree + 'shapeTreeRoot'), namedNode(shapeTreeUrl.href));
    return q ? new URL(q.subject.value) : null;
  }


  /** Install (plant) a ShapeTree instance.
   * @param shapeTreeUrl: URL of ShapeTree to be planted
   * @param postedContainer: parent Container where instance should appear
   * @param requestedName: url of created ShapeTree instance
   * @param payloadGraph: RDF payload POSTed in the plant request
   */
  /** registerInstance - register a new ShapeTree instance
   * @param appData: RDFJS DataSet
   * @param {ShapeTree.RemoteShapeTree} shapeTreeUrl
   * @param instanceUrl: location of the ShapeTree instance
   */
  async registerInstance(appData, shapeTreeUrl, instanceUrl) {
    const funcDetails = Details.extend(`registerInstance(<%{appData}>, <${shapeTreeUrl.href}> <%{instanceUrl.pathname}>)`);
    funcDetails('');
    funcDetails(`apps = new Container(${this.appsUrl.pathname}, 'Applications Directory', null, null)`);
    const apps = await new this.shapeTree.Container(this.appsUrl, 'Applications Directory', null, null).ready;
    funcDetails(`new Container(${new URL(appData.name + '/', this.appsUrl).pathname}, ${appData.name + ' Directory'}, null, null).ready`);
    const app = await new this.shapeTree.Container(new URL(appData.name + '/', this.appsUrl), appData.name + ' Directory', null, null).ready;
    apps.addMember(app.url, shapeTreeUrl);
    funcDetails('apps.write');
    await apps.write();
    const prefixes = {
      ldp: Prefixes.ldp,
      tree: Prefixes.tree,
      xsd: Prefixes.xsd,
      dcterms: Prefixes.dc,
    }
    const appFileText = Object.entries(prefixes).map(p => `PREFIX ${p[0]}: <${p[1]}>`).join('\n') + `
<> tree:installedIn
  [ tree:app <${appData.planted}> ;
    tree:shapeTreeRoot <${shapeTreeUrl.href}> ;
    tree:shapeTreeInstancePath <${instanceUrl.href}> ;
  ] .
<${appData.planted}> tree:name "${appData.name}" .
`    // could add tree:instantiationDateTime "${new Date().toISOString()}"^^xsd:dateTime ;
    const toAdd = await this._rdfInterface.parseTurtle(appFileText, app.url, prefixes);
    app.merge(toAdd);
    Object.assign(app.prefixes, prefixes);
    funcDetails('app.write');
    await app.write();
    return [toAdd, prefixes];
  }

  /** parse payload when planting a ShapeTree
   * @param graph: RDFJS Store
   */
  parseInstatiationPayload (graph) {
    const planted = this._rdfInterface.one(graph, null, namedNode(Prefixes.ldp + 'app'), null).object;
    const name = this._rdfInterface.one(graph, planted, namedNode(Prefixes.ldp + 'name'), null).object;
    return {
      planted: planted.value,
      name: name.value
    };
  }

  /** a caching wrapper for fetch
   */
  async cachingFetch (url, /* istanbul ignore next */options = {}) {
    // const funcDetails = Details.extend(`cachingFetch(<${url.href}>, ${JSON.stringify(options)})`);
    const funcDetails = require('debug')('						cachingFetch').extend('details').extend(`cachingFetch(<${url.href}>, ${JSON.stringify(options)})`);
    funcDetails('');
    const prefixes = {};
    const cacheUrl = new URL(cacheName(url.href), this.cacheUrl);
    funcDetails('this.storage.rstat(<%s>)', cacheUrl.pathname);
    if (new URL('/', this.cacheUrl).href === new URL('/', url).href) {
      return Fetch(url, options);
    } else if (!await this.storage.rstat(cacheUrl).then(stat => true, e => false)) {
      // The first time this url was seen, put the mime type and payload in the cache.

      Log('cache miss on', url.href, '/', cacheUrl.href)
      funcDetails('Errors.getOrThrow(Fetch, <%s>)', url.pathname);
      const resp = await Errors.getOrThrow(Fetch, url, options);
      const text = await resp.text();
      const headers = Array.from(resp.headers).filter(
        // Hack: remove date and time to reduce visible churn in cached contents.
        pair => !pair[0].match(/date|time/),
      ).reduce(
        (map, pair) => map.set(pair[0], pair[1]),
        new Map()
      );
      // Is there any real return on treating the cacheDir as a Container?

      // const image = `${mediaType}\n\n${text}`;
      const image = Array.from(headers).map(
        pair => `${escape(pair[0])}: ${escape(pair[1])}`
      ).join('\n')+'\n\n' + text;
      funcDetails('storage.write(<%s>, "%s...")', cacheUrl.pathname, image.substr(0, 60).replace(/\n/g, '\\n'));
      await this.storage.write(cacheUrl, image);
      Log('cached', url.href, 'size:', text.length, 'type:', headers.get('content-type'), 'in', cacheUrl.href)
      // return resp;
      return new FakeResponse(url, headers, text);
    } else {
      // Pull mime type and payload from cache.

      funcDetails('storage.read(<%s>)', cacheUrl.pathname);
      const image = await this.storage.read(cacheUrl);
      // const [mediaType, text] = image.match(/([^\n]+)\n\n(.*)/s).slice(1);
      const eoh = image.indexOf('\n\n');
      const text = image.substr(eoh + 2);
      const headers = image.substr(0, eoh).split(/\n/).reduce((map, line) => {
        const [key, val] = line.match(/^([^:]+): (.*)$/).map(decodeURIComponent).slice(1);
        return map.set(key, val);
      }, new Map());
      Log('cache hit on ', url.href, 'size:', text.length, 'type:', headers.get('content-type'), 'in', cacheUrl.href)
      return new FakeResponse(url, headers, text);
    }
  }
};

/** private function to calculate cache names.
 */
function cacheName (url) {
  const copy = new URL(url);
  copy.hash = ''; // All fragments share the same cache entry.
  return copy.href.replace(/[^a-zA-Z0-9_-]/g, '');
}

module.exports = SimpleApps;
