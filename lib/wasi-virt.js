export class Exit extends Error {
  constructor(code = 0) {
    super(`Exited with status ${code}`);
    this.code = code;
  }
}

function monotonicNow() {
  return BigInt(Math.floor(performance.now() * 1e6));
}

function wallClockNow() {
  let now = Date.now(); // in milliseconds
  const seconds = BigInt(Math.floor(now / 1e3));
  const nanoseconds = (now % 1e3) * 1e6;
  return { seconds, nanoseconds };
}

class Xoroshiro128StarStar {
  constructor(seed) {
    if (BigInt(seed) === 0n) {
      throw new Error("xoroshiro128** must be seeded with a non-zero state");
    }
    this.s = [BigInt(seed) & 0xffffffffffffffffn, (BigInt(seed) >> 64n) & 0xffffffffffffffffn];
  }

  next() {
    function trunc64(x) { return x & 0xffffffffffffffffn; }
    function rotl(x, k) { return (x << k) | (x >> (64n - k)); }

    let [s0, s1] = this.s;
    const r = trunc64(rotl(s0 * 5n, 7n) * 9n);
    s1 ^= s0;
    s0 = trunc64(rotl(s0, 24n) ^ s1 ^ (s1 << 16n));
    s1 = trunc64(rotl(s1, 37n));
    this.s = [s0, s1];
    return r;
  }

  getBytes(length) {
    return Uint8Array.from({ length }, () => Number(BigInt.asUintN(8, this.next() >> 32n)));
  }
}

class IoError extends Error {}

class InputStream {
  read(_len) {
    throw { tag: 'closed' };
  }

  blockingRead(len) {
    return this.read(len);
  }
}

class OutputStream {
  checkWrite() {
    throw { tag: 'closed' };
  }

  write(_contents) {
    this.checkWrite();
  }

  flush() {}

  blockingFlush() {
    this.flush();
  }

  blockingWriteAndFlush(contents) {
    this.write(contents);
    this.blockingFlush();
  }
}

class TerminalInput {}
class TerminalOutput {}

class TerminalOutputStream extends OutputStream {
  buffer = "";

  constructor(printLine = console.log) {
    super();
    this.printLine = printLine;
  }

  checkWrite() {
    return 4096;
  }

  write(contents) {
    this.buffer += new TextDecoder().decode(contents);
    let newlineAt = -1;
    while (true) {
      const nextNewlineAt = this.buffer.indexOf('\n', newlineAt + 1);
      if (nextNewlineAt === -1) {
        break;
      }
      this.printLine(this.buffer.substring(newlineAt + 1, nextNewlineAt));
      newlineAt = nextNewlineAt;
    }
    this.buffer = this.buffer.substring(newlineAt + 1);
  }
}

class File {
  constructor(data = "") {
    if (data instanceof Uint8Array) {
      this.data = data;
    } else if (typeof data === 'string') {
      this.data = new TextEncoder().encode(data);
    } else {
      throw new Error(`Cannot construct a file from ${typeof data}`);
    }
  }

  get size() {
    return this.data.length;
  }
}

class ReadStream extends InputStream {
  constructor(file, offset) {
    super();
    this.file = file;
    this.offset = offset;
  }

  read(len) {
    const data = this.file.data.subarray(Number(this.offset), Number(this.offset + len));
    this.offset += len;
    return data;
  }
}

class WriteStream extends OutputStream {
  constructor(file, offset) {
    super();
    this.file = file;
    this.offset = offset;
  }

  write(contents) {
    const newData = new Uint8Array(this.file.data.length + contents.length);
    newData.set(this.file.data);
    newData.subarray(Number(this.offset)).set(contents);
    this.file.data = newData;
    this.offset += BigInt(contents.length);
  }
}

class Directory {
  constructor(files = {}) {
    this.files = files;
  }

  get size() {
    return Object.keys(this.files).length;
  }

  traverse(path, flags = { create: false, remove: false }) {
    let entry = this;
    let separatorAt = -1;
    do {
      if (entry instanceof File)
        throw 'not-directory';
      const files = entry.files;
      separatorAt = path.indexOf('/');
      const segment = separatorAt === -1 ? path : path.substring(0, separatorAt);
      if (separatorAt === -1 && flags.remove)
        delete files[segment];
      else if (segment === '' || segment === '.')
        /* disregard */;
      else if (segment === '..')
        /* hack to make scandir() work */;
      else if (Object.hasOwn(files, segment))
        entry = files[segment];
      else if (flags.create === 'directory' || flags.create === 'file' && separatorAt !== -1)
        entry = files[segment] = new Directory({});
      else if (flags.create === 'file')
        entry = files[segment] = new File(new Uint8Array());
      else
        throw 'no-entry';
      path = path.substring(separatorAt + 1);
    } while (separatorAt !== -1);
    return entry;
  }
}

class Descriptor {
  constructor(entry) {
    this.entry = entry;
  }

  getType() {
    if (this.entry instanceof Directory)
      return 'directory';
    if (this.entry instanceof File)
      return 'regular-file';
  }

  getFlags() {
    return {};
  }

  metadataHash() {
    return { upper: 0, lower: 0 };
  }

  metadataHashAt(_pathFlags, path) {
    if (!(this.entry instanceof Directory))
      throw 'invalid';
    const pathEntry = this.entry.traverse(path);
    return new Descriptor(pathEntry).metadataHash();
  }

  stat() {
    let type;
    if (this.entry instanceof Directory)
      type = 'directory';
    if (this.entry instanceof File)
      type = 'regular-file';
    return {
      type: type,
      linkCount: 1,
      size: this.entry.size,
      dataAccessTimestamp: null,
      dataModificationTimestamp: null,
      statusChangeTimestamp: null
    };
  }

  statAt(_pathFlags, path) {
    if (!(this.entry instanceof Directory))
      throw 'invalid';
    const pathEntry = this.entry.traverse(path);
    return new Descriptor(pathEntry).stat();
  }

  openAt(_pathFlags, path, openFlags, _descriptorFlags) {
    if (!(this.entry instanceof Directory))
      throw 'invalid';
    const openEntry = this.entry.traverse(path, { create: openFlags.create ? 'file' : false });
    if (openFlags.directory) {
      if (!(openEntry instanceof Directory))
        throw 'not-directory';
    } else {
      if (openEntry instanceof Directory)
        throw 'is-directory';
      if (openFlags.truncate)
        openEntry.data = new Uint8Array();
    }
    return new Descriptor(openEntry);
  }

  read(length, offset) {
    if (this.entry instanceof Directory)
      throw 'is-directory';
    [length, offset] = [Number(length), Number(offset)];
    return [this.entry.data.subarray(offset, offset + length), offset + length >= this.entry.data.byteLength];
  }

  readViaStream(offset) {
    return new ReadStream(this.entry, offset);
  }

  write(_buffer, _offset) {
    if (this.entry instanceof Directory)
      throw 'is-directory';
    console.error('Descriptor.write not implemented');
    throw 'unsupported';
  }

  writeViaStream(offset) {
    return new WriteStream(this.entry, offset);
  }

  readDirectory() {
    return new DirectoryEntryStream(this.entry);
  }

  createDirectoryAt(path) {
    this.entry.traverse(path, { create: 'directory' });
  }

  unlinkFileAt(path) {
    const pathEntry = this.entry.traverse(path);
    if (pathEntry instanceof Directory)
      return 'is-directory';
    this.entry.traverse(path, { remove: true });
  }

  removeDirectoryAt(path) {
    const pathEntry = this.entry.traverse(path);
    if (!(pathEntry instanceof Directory))
      return 'not-directory';
    this.entry.traverse(path, { remove: true });
  }
}

class DirectoryEntryStream {
  constructor(directory) {
    this.entries = Object.entries(directory.files);
    this.index = 0;
  }

  readDirectoryEntry() {
    if (this.index === this.entries.length)
      return null;
    const [name, entry] = this.entries[this.index++];
    let type;
    if (entry instanceof Directory)
      type = 'directory';
    if (entry instanceof File)
      type = 'regular-file';
    return { name, type };
  }
}

export function directoryFromTree(tree) {
  const files = {};
  for(const [filename, data] of Object.entries(tree)) {
    if (typeof data === 'string' || data instanceof Uint8Array)
      files[filename] = new File(tree[filename]);
    else
      files[filename] = directoryFromTree(tree[filename]);
  }
  return new Directory(files);
}

export function directoryIntoTree(directory, { decodeASCII = true } = {}) {
  function isASCII(buffer) {
    for (const byte of buffer)
      if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte >= 0x7f)
        return false;
    return true;
  }

  const tree = {};
  for (const [filename, entry] of Object.entries(directory.files)) {
    if (entry instanceof File)
      tree[filename] = (decodeASCII && isASCII(entry.data)) ? new TextDecoder().decode(entry.data) : entry.data;
    if (entry instanceof Directory)
      tree[filename] = directoryIntoTree(entry, { decodeASCII });
  }
  return tree;
}

export class Environment {
  vars = {};
  args = [];
  root = new Directory({});

  constructor() {
    this.prng = new Xoroshiro128StarStar(1n);

    this.terminalInputStream = new InputStream();
    this.terminalOutputStream = new TerminalOutputStream();

    this.terminalInput = new TerminalInput();
    this.terminalOutput = new TerminalOutput();

    const $this = this;
    this.exports = {
      monotonicClock: {
        now: monotonicNow
      },
      wallClock: {
        now: wallClockNow
      },
      random: {
        getRandomBytes(length) { return $this.prng.getBytes(Number(length)); }
      },
      io: {
        Error: IoError,
        InputStream,
        OutputStream,
      },
      cli: {
        exit(status) { throw new Exit(status.tag === 'ok' ? 0 : 1); },
        getEnvironment() { return $this.vars; },
        getArguments() { return $this.args; },
        getStdin() { return $this.terminalInputStream; },
        getStdout() { return $this.terminalOutputStream; },
        getStderr() { return $this.terminalOutputStream; },
        getTerminalStdin() { return $this.terminalInput; },
        getTerminalStdout() { return $this.terminalOutput; },
        getTerminalStderr() { return $this.terminalOutput; },
        TerminalInput,
        TerminalOutput,
      },
      fs: {
        Descriptor,
        DirectoryEntryStream,
        filesystemErrorCode() {},
        getDirectories() {
          if ($this.root === null) return [];
          return [[new Descriptor($this.root), "/"]];
        },
      }
    };
  }

  get printLine() {
    return this.terminalOutputStream.printLine;
  }

  set printLine(fn) {
    this.terminalOutputStream.printLine = fn;
  }
}
