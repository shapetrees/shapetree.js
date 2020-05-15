/** ShapeTree - simple structure to associate resource hiearchies with shapes and media types
 *
 * This library provides:
 *   Container - an LDPC.
 *   ManagedContainer - an LDPC under ShapeTree control.
 *   loadContainer - loads either a Container or a ManagedContainer.
 *   RemoteShapeTree - a parsed ShapeTree structure.
 */
function ShapeTreeFunctions (fileSystem, rdfInterface, fetch) {

const Path = require('path');
const N3 = require("n3");
const { namedNode, literal, defaultGraph, quad } = N3.DataFactory;
const Errors = require('./rdf-errors');
const Prefixes = require('./prefixes');
const UriTemplate = require('uri-template-lite').URI.Template;
const ShExCore = require('@shexjs/core')
const ShExParser = require('@shexjs/parser')

class Mutex {
  constructor() {
    this._locking = Promise.resolve();
    this._locks = 0;
  }

  lock () {
    this._locks += 1;
    let unlockNext;
    let willLock = new Promise(resolve => unlockNext = () => {
      this._locks -= 1;
      resolve();
    });
    let willUnlock = this._locking.then(() => unlockNext);
    this._locking = this._locking.then(() => willLock);
    return willUnlock;
  }
}


/** Container - an LDPC
 * @param url: URL of Container
 * @param title: dc:title of container | an N3.Store for already-read graphs.
 */
class Container {
  constructor (url, title) {
    if (!(url instanceof URL))
      throw Error(`url ${url} must be an instance of URL`);
    if (!(url.pathname.endsWith('/')))
      throw Error(`url ${url} must end with '/'`);
    if (url.pathname.endsWith('//'))
      throw Error(`url ${url} ends with '//'`);
    this.url = url;
    this.prefixes = title instanceof Array ? title[1] : {};
    this._mutex = new Mutex()
    this.graph = title instanceof Array ? title[0] : new N3.Store();
    this.subdirs = [];

    this.ready = title instanceof Array ? Promise.resolve(this) : loadOrCreate.call(this);

    async function loadOrCreate () {
      // if (!await fileSystem.exists(this.path)) \__ %%1: yields so even in one thread, someone else can always mkdir first
      //   await fileSystem.mkdir(this.path);     /   Solid needs a transactions so folks don't trump each other's Containers
      const unlock = await this._mutex.lock();
      const [newDir, containerGraph] = await fileSystem.ensureContainer(this.url, this.prefixes, title);
      this.newDir = newDir;
      this.graph.addQuads(containerGraph.getQuads());
      unlock();
      return /*this*/ new Promise((res, rej) => { // !!DELME sleep for a bit to surface bugs
        setTimeout(() => {
          res(this)
        }, 20);
      });
    }
  }

  async write () {
    const unlock = await this._mutex.lock();
    await fileSystem.writeContainer(this.graph, this.url, this.prefixes).then(
      x => { unlock(); return x; },
      e => /* istanbul ignore next */ { unlock(); throw e; }
    );
    return this
  }

  async remove () {
    const unlock = await this._mutex.lock();
    return fileSystem.removeContainer(this.url).then(
      x => { unlock(); return x; },
      e => /* istanbul ignore next */ { unlock(); throw e; }
    );
  }

  async merge (payload, base) {
    // istanbul ignore next
    const g2 = payload instanceof N3.Store ? payload : await rdfInterface.parseTurtle(payload, base, this.prefixes);
    this.graph.addQuads(g2.getQuads());
    return this
  }

  addMember (location, shapeTreeUrl) {
    this.graph.addQuad(namedNode(this.url.href), namedNode(Prefixes.ns_ldp + 'contains'), namedNode(location));
    return this
  }

  removeMember (location, shapeTreeUrl) {
    this.graph.removeQuad(namedNode(this.url.href), namedNode(Prefixes.ns_ldp + 'contains'), namedNode(location));
    return this
  }
}

/** ManagedContainer - an LDPC with shapeTrees
 * @param url: URL of Container
 * @param title: dc:title of container | a [N3.Store, prefixex] for already-read graphs (hack).
 * @param shapeTreeUrl: the URL of the ShapeTree that defines this instance.
 * @param shapeTreeInstancePath: the path from the root of this ShapeTree instance.
 */
class ManagedContainer extends Container {
  constructor (url, title, shapeTreeUrl, shapeTreeInstancePath) {
    super(url, title);
    if (title instanceof Array) {
      parseShapeTreeInstance.call(this);
    } else {
      if (!(shapeTreeUrl instanceof URL))
        throw Error(`shapeTreeUrl ${shapeTreeUrl} must be an instance of URL`);
      this,shapeTreeUrl = shapeTreeUrl;
      this.shapeTreeInstancePath = shapeTreeInstancePath;
      this.shapeTreeInstanceRoot = null;
      this.shapeTreeInstanceRoot = new URL(Path.relative(shapeTreeInstancePath, ''), shapeTreeUrl);
      this.ready = this.ready.then(() => loadOrCreate.call(this));
    }

    async function loadOrCreate () {
      // if (!await fileSystem.exists(this.path)) \__ %%1: yields so even in one thread, someone else can always mkdir first
      //   await fileSystem.mkdir(this.path);     /   Solid needs a transactions so folks don't trump each other's Containers
      const unlock = await this._mutex.lock();
      if (this.newDir) {
        const c = containerText(title, shapeTreeUrl, shapeTreeInstancePath, this.prefixes);
        const s = await rdfInterface.parseTurtle(c, this.url, this.prefixes);
        this.graph.addQuads(s.getQuads());
        await fileSystem.writeContainer(this.graph, this.url, this.prefixes);
      } else {
        parseShapeTreeInstance.call(this);
      }
      unlock();
      return /*this*/ new Promise((res, rej) => { // !!DELME sleep for a bit to surface bugs
        setTimeout(() => {
          res(this)
        }, 20);
      });

      function containerText (title, shapeTreeUrl, shapeTreeInstancePath, prefixes) {
        return `
@prefix dcterms: <http://purl.org/dc/terms/>.
@prefix ldp: <http://www.w3.org/ns/ldp#>.
@prefix tree: <${Prefixes.ns_tree}>.

<>
   tree:shapeTreeRoot <${shapeTreeUrl.href}> ;
   tree:shapeTreeInstancePath "${shapeTreeInstancePath}" ;
   tree:shapeTreeInstanceRoot <${Path.relative(shapeTreeInstancePath, '')}> .
`
      }
    }

    function parseShapeTreeInstance () {
      this.shapeTreeInstanceRoot = asUrl(this.graph, this.url, 'shapeTreeInstanceRoot');
      this.shapeTreeInstancePath = asLiteral(this.graph, this.url, 'shapeTreeInstancePath');
      this.shapeTreeUrl = asUrl(this.graph, this.url, 'shapeTreeRoot');
    }
  }

  addSubdirs (addUs) {
    this.subdirs.push(...addUs);
    return this
  }

  async getRootedShapeTree () {
    const path = rdfInterface.one(this.graph, namedNode(this.url.href), namedNode(Prefixes.ns_tree + 'shapeTreeInstancePath'), null).object.value;
    const root = rdfInterface.one(this.graph, namedNode(this.url.href), namedNode(Prefixes.ns_tree + 'shapeTreeRoot'), null).object.value;
    return new RemoteShapeTree(new URL(root), path)
  }
}

function asUrl (g, s, p) {
  const ret = rdfInterface.zeroOrOne(g, namedNode(s.href), namedNode(Prefixes.ns_tree + p), null);
  return ret ? new URL(ret.object.value) : null;
}

function asLiteral (g, s, p) {
  const ret = rdfInterface.zeroOrOne(g, namedNode(s.href), namedNode(Prefixes.ns_tree + p), null);
  return ret ? ret.object.value : null;
}

/** loadContainer - read an LDPC from the filesystem
 * @param url: URL of Container
 */
async function loadContainer (url) {
  const prefixes = {};
  const containerGraph = await fileSystem.readContainer(url, prefixes);
  return asUrl(containerGraph, url, 'shapeTreeInstanceRoot')
    ? new ManagedContainer(url, [containerGraph, prefixes])
    : new Container(url, [containerGraph, prefixes]);
}

class RemoteResource {
  constructor (url) {
    if (!(url instanceof URL)) throw Error(`url ${url} must be an instance of URL`);
    this.url = url;
    this.prefixes = {};
    this.graph = null;
  }

  async fetch () {
    const resp = await fetch(this.url);
    const mediaType = resp.headers.get('content-type').split(/; */)[0];
    const text = await resp.text();

    switch (mediaType) {
    case 'application/ld+json':
      // parse the JSON-LD into n-triples
      this.graph = await rdfInterface.parseJsonLd(text, this.url);
      break;
    case 'text/turtle':
      this.graph = await rdfInterface.parseTurtle (text, this.url, this.prefixes);
      break;
    default:
      /* istanbul ignore next */throw Error(`unknown media type ${mediaType} when parsing ${this.url.href}`)
    }
    return this;
  }
}

/** reference to a ShapeTree stored remotely
 *
 * @param url: URL string locating ShapeTree
 * @param path: refer to a specific node in the ShapeTree hierarchy
 *
 * A ShapeTree has contents:
 *     [] a rdf:ShapeTreeRoot, ldp:BasicContainer ; tree:contents
 *
 * The contents may be ldp:Resources:
 *         [ a ldp:Resource ;
 *           tree:uriTemplate "{labelName}.ttl" ;
 *           tree:shape gh:LabelShape ] ],
 * or ldp:Containers, which may either have
 * n nested static directories:
 *         [ a ldp:BasicContainer ;
 *           rdfs:label "repos" ;
 *           tree:contents ... ] ,
 *         [ a ldp:BasicContainer ;
 *           rdfs:label "users" ;
 *           tree:contents ... ]
 * or one dynamically-named member:
 *         [ a ldp:BasicContainer ;
 *           tree:uriTemplate "{userName}" ;
 *           tree:shape gh:PersonShape ;
 *           tree:contents ]
 */
class RemoteShapeTree extends RemoteResource {
  constructor (url, path = '.') {
    super(url);
    this.path = path
  }

  /** getRdfRoot - Walk through the path elements to find the target node.
   */
  getRdfRoot () {
    return this.path.split(/\//).reduce((node, name) => {
      if (name === '.')
        return node;
      // Get the contents of the node being examined
      const cqz = this.graph.getQuads(node, namedNode(Prefixes.ns_tree + 'contents'), null);
      // Find the element which either
      return cqz.find(
        q =>
          // matches the current label in the path
        this.graph.getQuads(q.object, namedNode(Prefixes.ns_rdfs + 'label'), literal(name)).length === 1
          ||
          // or has a uriTemplate (so it should be the sole element in the contents)
        this.graph.getQuads(q.object, namedNode(Prefixes.ns_tree + 'uriTemplate'), null).length === 1
      ).object
    }, namedNode(this.url.href));
  }

  /** firstChild - return the first contents.
   * @returns: { type, name, uriTemplate, shape, contents }
   */
  matchingStep (shapeTreeNode, slug) {
    const contents = this.graph.getQuads(shapeTreeNode, namedNode(Prefixes.ns_tree + 'contents'))
          .map(q => q.object);
    const choices = contents
          .filter(
            step => !slug ||
              new UriTemplate(
                this.graph.getQuads(step, namedNode(Prefixes.ns_tree + 'uriTemplate'))
                  .map(q2 => q2.object.value)[0]
              ).match(slug)
          );
    if (choices.length === 0)
      throw new Errors.UriTemplateMatchError(slug, [], `No match in ${shapeTreeNode.value} ${contents.map(t => t.value).join(', ')}`);
    /* istanbul ignore if */
    if (choices.length > 1) // @@ Could have been caught by static analysis of ShapeTree.
      throw new Errors.UriTemplateMatchError(slug, [], `Ambiguous match against ${contents.map(t => t.value).join(', ')}`);
    const g = this.graph;
    const typeNode = obj('expectedType')
    const ret = {
      node: choices[0],
      typeNode: typeNode,
      name: obj('name'),
      uriTemplate: obj('uriTemplate'),
      shape: obj('shape'),
      contents: this.graph.getQuads(choices[0], Prefixes.ns_tree + 'contents', null).map(t => t.object)
    };
    /* istanbul ignore else */ if (typeNode)
      ret.type = typeNode.value.replace(Prefixes.ns_ldp, '');
    return ret;

    function obj (property) {
      const q = rdfInterface.zeroOrOne(g, choices[0], namedNode(Prefixes.ns_tree + property), null);
      return q ? q.object : null;
    }
  }


  /** instantiateStatic - make all containers implied by the ShapeTree.
   * @param {RDFJS.Store} shapeTreeGraph - context ShapeTree in an RDF Store.
   * @param {RDFJS node} stepNode - subject of ldp:contents arcs of the LDP-Cs to be created.
   * @param {URL} rootUrl - root of the resource hierarchy (path === '/')
   * @param {URL} shapeTreeUrl - URL of context ShapeTree
   * @param {string} pathWithinShapeTree. e.g. "repos/someOrg/someRepo"
   */
  async instantiateStatic (stepNode, rootUrl, pathWithinShapeTree, parent) {
    const ret = await new ManagedContainer(rootUrl,
                                           `index for nested resource ${pathWithinShapeTree}`,
                                           this.url, pathWithinShapeTree).ready;
    try {
      parent.addMember(ret.url.href, stepNode.url);
      ret.addSubdirs(await Promise.all(this.graph.getQuads(stepNode, Prefixes.ns_tree + 'contents', null).map(async t => {
        const nested = t.object;
        const labelT = rdfInterface.zeroOrOne(this.graph, nested, namedNode(Prefixes.ns_rdfs + 'label'), null);
        if (!labelT)
          return;
        const toAdd = labelT.object.value;
        const step = new RemoteShapeTree(this.url, Path.join(pathWithinShapeTree, toAdd));
        step.graph = this.graph;
        return await step.instantiateStatic(nested, new URL(Path.join(toAdd, '/'), rootUrl), step.path, ret);
      })));
      parent.write(); // returns a promise
      return ret
    } catch (e) {
      await ret.remove(); // remove the Container
      parent.removeMember(ret.url.href, stepNode.url);
      if (e instanceof Errors.ManagedError)
        throw e;
      throw new Errors.ShapeTreeStructureError(rootUrl.href, e.message);
    }
  }

  async validate (shape, payloadGraph, node) {
    // shape is a URL with a fragement. shapeBase is that URL without the fragment.
    const shapeBase = new URL(shape);
    shapeBase.hash = '';
    let schemaResp = await Errors.getOrThrow(fetch, shapeBase); // throws if unresolvable
    // const schemaType = schemaResp.headers.get('content-type').split(/; */)[0];
    const schemaPrefixes = {};
    const schema = ShExParser.construct(shapeBase.href, schemaPrefixes, {})
          .parse(await schemaResp.text());
    const v = ShExCore.Validator.construct(schema);
    let res
    try {
      res = v.validate(ShExCore.Util.makeN3DB(payloadGraph), node, shape);
    } catch (e) {
      throw new Errors.MissingShapeError(shape, e.message);
    }
    if ('errors' in res) {
      // We could log this helpful server-side debugging info:
      //   console.warn(ShExCore.Util.errsToSimple(res).join('\n'));
      //   console.warn(`<${node}>@<${shape}>`);
      //   console.warn(payloadGraph.getQuads().map(q => (['subject', 'predicate', 'object']).map(pos => q[pos].value).join(' ')).join('\n'));
      throw new Errors.ValidationError(node, shape, ShExCore.Util.errsToSimple(res).join('\n'));
    }
  }
}


  const fsHash = fileSystem.hashCode();
  /* istanbul ignore if */if (ShapeTreeFunctions[fsHash])
    return ShapeTreeFunctions[fsHash];

  return ShapeTreeFunctions[fsHash] = {
    RemoteShapeTree,
    Container,
    ManagedContainer,
    loadContainer,
  }
}

module.exports = ShapeTreeFunctions;