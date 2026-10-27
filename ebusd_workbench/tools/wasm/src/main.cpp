// ebusd-check: load ebusd CSV message definitions and decode telegrams with ebusd's own
// message library. Built to WebAssembly (wasm32-wasi) so it can run in the browser.
//
// usage: ebusd-check [--configpath=DIR] [--lang=LANG] [--file=REL.csv]... [--verbose] [--debug]
//                    [--candidates] [--dump] [MESSAGE|-]...
//   MESSAGE is a telegram as QQZZPBSBNNDD/NNDD (slave part may be empty), "-" reads one per line
//   from stdin (also without any MESSAGE).
//   --candidates lists every definition that matches a telegram, also ones ebusd would not use:
//   conditional ones whose condition is not met and ones from files of other device variants,
//   each with its siblings (the definitions of the same name in the same file, e.g. for writing).
// Output: one JSON object per line on stdout; log lines on stderr.
#include <dirent.h>
#include <sys/stat.h>
#include <algorithm>
#include <cstring>
#include <iostream>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>
// The candidate listing walks the message map and reads the file and condition of a message;
// ebusd keeps those protected. This build is a self-contained tool, so the access check is lifted.
#define private public
#define protected public
#include "lib/ebus/message.h"
#undef private
#undef protected
#include "lib/ebus/data.h"
#include "lib/ebus/filereader.h"
#include "lib/ebus/result.h"
#include "lib/ebus/symbol.h"
#include "lib/utils/log.h"

using namespace ebusd;
using std::string;
using std::vector;
using std::map;
using std::cout;
using std::ostringstream;

static string jsonEscape(const string& s) {
  ostringstream o;
  for (unsigned char c : s) {
    switch (c) {
      case '"': o << "\\\""; break;
      case '\\': o << "\\\\"; break;
      case '\n': o << "\\n"; break;
      case '\r': o << "\\r"; break;
      case '\t': o << "\\t"; break;
      default:
        if (c < 0x20) { char buf[8]; snprintf(buf, sizeof(buf), "\\u%04x", c); o << buf; } else { o << c; }
    }
  }
  return o.str();
}

static string oneLine(string s) {
  for (char& c : s) if (c == '\n' || c == '\r') c = ' ';
  return s;
}

static string hex2(unsigned value) {
  char buf[4];
  snprintf(buf, sizeof(buf), "%02x", value & 0xff);
  return buf;
}

struct Ident {
  string manufacturer, ident, sw, hw, file;
};

class CheckResolver : public Resolver {
 public:
  CheckResolver(MessageMap* messages, const string& configPath, bool verbose)
    : m_messages(messages), m_configPath(configPath), m_verbose(verbose) {}
  ~CheckResolver() override {
    for (auto& it : m_templatesByPath) if (it.second != &m_globalTemplates) delete it.second;
  }

  DataFieldTemplates* getTemplates(const string& filename) override {
    if (filename == "*") {
      size_t maxLength = 0;
      DataFieldTemplates* best = nullptr;
      for (auto it : m_templatesByPath) if (it.first.size() > maxLength) { best = it.second; maxLength = it.first.size(); }
      if (best) return best;
    } else {
      string path;
      size_t pos = filename.find_last_of('/');
      if (pos != string::npos) path = filename.substr(0, pos);
      const auto it = m_templatesByPath.find(path);
      if (it != m_templatesByPath.end()) return it->second;
    }
    return &m_globalTemplates;
  }

  result_t loadDefinitionsFromConfigPath(FileReader* reader, const string& filename, map<string, string>* defaults,
      string* errorDescription, bool replace = false) override {
    time_t mtime = 0;
    std::istream* stream = FileReader::openFile(m_configPath + "/" + filename, errorDescription, &mtime);
    if (!stream) return RESULT_ERR_NOTFOUND;
    result_t result = reader->readFromStream(stream, filename, mtime, m_verbose, defaults, errorDescription, replace);
    delete stream;
    return result;
  }

  /** Load the templates of a directory (once). */
  void readTemplates(const string& relPath) {
    if (m_templatesByPath.find(relPath) != m_templatesByPath.end()) return;
    string file = (relPath.empty() ? "" : relPath + "/") + "_templates.csv";
    struct stat st;
    bool available = stat((m_configPath + "/" + file).c_str(), &st) == 0;
    DataFieldTemplates* templates = (relPath.empty() || !available) ? &m_globalTemplates : new DataFieldTemplates(m_globalTemplates);
    m_templatesByPath[relPath] = templates;
    if (!available) return;
    string errorDescription;
    result_t result = loadDefinitionsFromConfigPath(templates, file, nullptr, &errorDescription, true);
    if (result == RESULT_OK) {
      logInfo(lf_main, "read templates in %s", relPath.empty() ? "/" : relPath.c_str());
    } else {
      logError(lf_main, "error reading templates in %s: %s, %s", relPath.empty() ? "/" : relPath.c_str(),
               getResultCode(result), errorDescription.c_str());
      m_errors++;
    }
  }

  /** Load one message definition file (and the templates of its directory first). */
  result_t loadFile(const string& relFile) {
    string dir;
    size_t pos = relFile.find_last_of('/');
    if (pos != string::npos) dir = relFile.substr(0, pos);
    readTemplates("");
    if (!dir.empty()) readTemplates(dir);
    string errorDescription;
    result_t result = loadDefinitionsFromConfigPath(m_messages, relFile, nullptr, &errorDescription);
    if (result == RESULT_OK) {
      logInfo(lf_main, "read file %s", relFile.c_str());
      m_loaded.push_back(relFile);
    } else {
      logError(lf_main, "error reading file %s: %s, %s", relFile.c_str(), getResultCode(result), errorDescription.c_str());
      m_errors++;
    }
    return result;
  }

  /** List the CSV files and sub directories of a directory. */
  void list(const string& relPath, vector<string>* files, vector<string>* dirs) {
    string path = m_configPath + (relPath.empty() ? "" : "/" + relPath);
    DIR* dir = opendir(path.c_str());
    if (!dir) return;
    dirent* d;
    while ((d = readdir(dir)) != nullptr) {
      string name = d->d_name;
      if (name == "." || name == ".." || name == "_templates.csv") continue;
      struct stat st;
      if (stat((path + "/" + name).c_str(), &st) != 0) continue;
      string rel = relPath.empty() ? name : relPath + "/" + name;
      if (S_ISDIR(st.st_mode)) dirs->push_back(rel);
      else if (name.size() > 4 && name.compare(name.size() - 4, 4, ".csv") == 0) files->push_back(rel);
    }
    closedir(dir);
    std::sort(files->begin(), files->end());
    std::sort(dirs->begin(), dirs->end());
  }

  /** Load all CSV files of a directory like "ebusd --checkconfig" does (recursively). */
  void loadAll(const string& relPath) {
    vector<string> files, dirs;
    list(relPath, &files, &dirs);
    if (files.empty() && dirs.empty() && relPath.empty()) { logError(lf_main, "no CSV files in %s", m_configPath.c_str()); m_errors++; }
    readTemplates(relPath);
    for (const auto& f : files) loadFile(f);
    for (const auto& sub : dirs) loadAll(sub);
  }

  /** All CSV files below the configuration path (recursively). */
  vector<string> allFiles() {
    vector<string> result, dirs{""};
    while (!dirs.empty()) {
      string dir = dirs.front();
      dirs.erase(dirs.begin());
      vector<string> files, subs;
      list(dir, &files, &subs);
      result.insert(result.end(), files.begin(), files.end());
      dirs.insert(dirs.end(), subs.begin(), subs.end());
    }
    return result;
  }

  /** The file ebusd's scan would load for a device, like ScanHelper::loadScanConfigFile. */
  string scanFile(symbol_t address, const string& manufacturer, string ident, unsigned sw, unsigned hw) {
    string manuf = manufacturer;
    std::transform(manuf.begin(), manuf.end(), manuf.begin(), ::tolower);
    for (auto it = ident.begin(); it != ident.end();) {
      if (*it != '_' && !::isalnum(*it)) it = ident.erase(it);
      else { *it = static_cast<char>(::tolower(*it)); it++; }
    }
    string prefix = manuf + "/" + hex2(address) + ".";
    string best;
    size_t bestMatch = 0;
    for (const auto& name : allFiles()) {
      if (name.compare(0, prefix.size(), prefix) != 0) continue;
      symbol_t checkDest;
      unsigned checkSw, checkHw;
      map<string, string> defaults;
      if (!m_messages->extractDefaultsFromFilename(name.substr(manuf.size() + 1), &defaults, &checkDest, &checkSw, &checkHw)) continue;
      if (address != checkDest || (checkSw != UINT_MAX && sw != checkSw) || (checkHw != UINT_MAX && hw != checkHw)) continue;
      size_t match = 1;
      string checkIdent = defaults["name"];
      if (!checkIdent.empty()) {
        string remain = ident;
        bool matches = false;
        while (remain.length() > 0 && remain.length() >= checkIdent.length()) {
          if (checkIdent == remain) { matches = true; break; }
          if (!::isdigit(remain[remain.length() - 1])) break;
          remain.erase(remain.length() - 1);
        }
        if (!matches) continue;
        match += remain.length();
      }
      if (match > bestMatch || (match == bestMatch && name.length() > best.length())) { bestMatch = match; best = name; }
    }
    return best;
  }

  int errors() const { return m_errors; }
  const vector<string>& loaded() const { return m_loaded; }

 private:
  MessageMap* m_messages;
  string m_configPath;
  bool m_verbose;
  DataFieldTemplates m_globalTemplates;
  map<string, DataFieldTemplates*> m_templatesByPath;
  vector<string> m_loaded;
  int m_errors = 0;
};

/** Index of all loaded messages by destination, PB and SB for the candidate listing. */
class Candidates {
 public:
  explicit Candidates(MessageMap* messages) : m_messages(messages) {
    std::set<Message*> seen;
    for (const auto& it : messages->m_messagesByKey) {
      for (Message* message : it.second) {
        if (!seen.insert(message).second || message->isScanMessage()) continue;
        m_byCommand[key(message->getDstAddress(), message->getPrimaryCommand(), message->getSecondaryCommand())].push_back(message);
        m_byName[message->m_filename + "|" + message->getCircuit() + "|" + message->getName()].push_back(message);
      }
    }
  }

  /** The other definitions of the same file, circuit and name (e.g. the write counterpart). */
  vector<Message*> siblings(Message* message) {
    vector<Message*> result;
    auto it = m_byName.find(message->m_filename + "|" + message->getCircuit() + "|" + message->getName());
    if (it != m_byName.end()) for (Message* other : it->second) if (other != message) result.push_back(other);
    return result;
  }

  /** All messages whose destination, command and ID fit the master part. */
  vector<Message*> matching(const MasterSymbolString& master) {
    vector<Message*> result;
    symbol_t zz = master[1], pb = master[2], sb = master[3];
    for (symbol_t dst : {zz, (symbol_t)SYN}) {
      auto it = m_byCommand.find(key(dst, pb, sb));
      if (it == m_byCommand.end()) continue;
      for (Message* message : it->second) {
        if (message->getSrcAddress() != SYN && message->getSrcAddress() != master[0]) continue;
        if (!message->checkId(master, nullptr)) continue;
        result.push_back(message);
      }
    }
    std::sort(result.begin(), result.end(), [](Message* a, Message* b) {
      if (a->getIdLength() != b->getIdLength()) return a->getIdLength() > b->getIdLength();  // most specific first
      return a->m_filename < b->m_filename;
    });
    return result;
  }

 private:
  static uint32_t key(symbol_t dst, symbol_t pb, symbol_t sb) { return (dst << 16) | (pb << 8) | sb; }
  MessageMap* m_messages;
  map<uint32_t, vector<Message*>> m_byCommand;
  map<string, vector<Message*>> m_byName;
};

static void decodeInto(Message* message, const MasterSymbolString& master, const SlaveSymbolString& slave, ostringstream& out) {
  result_t result = message->storeLastData(master, slave);
  if (result == RESULT_OK) {
    ostringstream text;
    result = message->decodeLastData(pt_any, false, nullptr, -1, OF_NAMES | OF_UNITS, &text);
    if (result == RESULT_OK) {
      out << ",\"text\":\"" << jsonEscape(text.str()) << "\"";
      ostringstream json;
      if (message->decodeLastData(pt_any, false, nullptr, -1, OF_NAMES | OF_UNITS | OF_COMMENTS | OF_JSON | OF_ALL_ATTRS, &json) == RESULT_OK) {
        out << ",\"fields\":{" << oneLine(json.str()) << "}";
      }
    }
  }
  out << ",\"result\":\"" << (result == RESULT_OK ? "ok" : getResultCode(result)) << "\"";
}

static void describe(Message* message, ostringstream& out) {
  out << "\"circuit\":\"" << jsonEscape(message->getCircuit()) << "\",\"name\":\"" << jsonEscape(message->getName())
      << "\",\"write\":" << (message->isWrite() ? "true" : "false") << ",\"passive\":" << (message->isPassive() ? "true" : "false")
      << ",\"level\":\"" << jsonEscape(message->getLevel()) << "\",\"file\":\"" << jsonEscape(message->m_filename) << "\""
      << ",\"idlen\":" << message->getIdLength() << ",\"zz\":\"" << hex2(message->getDstAddress()) << "\"";
  if (message->getSrcAddress() != SYN) out << ",\"qq\":\"" << hex2(message->getSrcAddress()) << "\"";
  out << ",\"pbsb\":\"" << hex2(message->getPrimaryCommand()) << hex2(message->getSecondaryCommand()) << "\"";
  if (message->isConditional()) {
    ostringstream cond;
    message->m_condition->dump(false, &cond);
    out << ",\"condition\":\"" << jsonEscape(cond.str()) << "\",\"available\":" << (message->isAvailable() ? "true" : "false");
  } else {
    out << ",\"condition\":\"\",\"available\":true";
  }
}

static map<symbol_t, Ident> s_idents;

static void noteIdent(MessageMap* messages, CheckResolver* resolver, const MasterSymbolString& master, const SlaveSymbolString& slave) {
  // identification answer QQ ZZ 07 04 00 / 0a MM II II II II II SS SS HH HH
  if (slave.getDataSize() < 10) return;
  Message* scan = messages->getScanMessage(master[1]);
  if (!scan || scan->storeLastData(master, slave) != RESULT_OK) return;
  ostringstream out;
  if (scan->decodeLastData(pt_any, false, nullptr, -1, OF_NONE, &out) != RESULT_OK) return;
  // manufacturer;ident;SW;HW
  string text = out.str();
  vector<string> parts;
  size_t start = 0;
  while (true) {
    size_t pos = text.find(';', start);
    parts.push_back(text.substr(start, pos == string::npos ? string::npos : pos - start));
    if (pos == string::npos) break;
    start = pos + 1;
  }
  if (parts.size() < 4) return;
  Ident ident{parts[0], parts[1], parts[2], parts[3], ""};
  unsigned sw = 0, hw = 0;
  for (size_t i = 0; i < 4; i++) sw = sw * 10 + (slave.dataAt(6 + i / 2) >> (i % 2 ? 0 : 4) & 0xf);
  for (size_t i = 0; i < 4; i++) hw = hw * 10 + (slave.dataAt(8 + i / 2) >> (i % 2 ? 0 : 4) & 0xf);
  ident.file = resolver->scanFile(master[1], parts[0], parts[1], sw, hw);
  s_idents[master[1]] = ident;
}

static void decodeOne(MessageMap* messages, CheckResolver* resolver, Candidates* candidates, const string& arg) {
  cout << "{\"input\":\"" << jsonEscape(arg) << "\"";
  size_t pos = arg.find_first_of('/');
  string masterStr = pos == string::npos ? arg : arg.substr(0, pos);
  string slaveStr = pos == string::npos ? "" : arg.substr(pos + 1);
  MasterSymbolString master;
  SlaveSymbolString slave;
  result_t result = master.parseHex(masterStr);
  if (result == RESULT_OK && !slaveStr.empty()) result = slave.parseHex(slaveStr);
  if (result == RESULT_OK && master.size() < 5) result = RESULT_ERR_INVALID_ARG;
  if (result == RESULT_OK && !isMaster(master[0])) result = RESULT_ERR_INVALID_ADDR;
  if (result != RESULT_OK) {
    cout << ",\"error\":\"invalid telegram: " << getResultCode(result) << "\"}\n";
    return;
  }
  if (master[2] == 0x07 && master[3] == 0x04 && master.getDataSize() == 0) noteIdent(messages, resolver, master, slave);
  Message* message = messages->find(master);
  if (!message) {
    cout << ",\"found\":false";
  } else {
    ostringstream out;
    out << ",\"found\":true,";
    describe(message, out);
    decodeInto(message, master, slave, out);
    cout << out.str();
  }
  if (candidates) {
    cout << ",\"candidates\":[";
    bool first = true;
    for (Message* candidate : candidates->matching(master)) {
      ostringstream out;
      out << (first ? "{" : ",{");
      first = false;
      describe(candidate, out);
      out << ",\"selected\":" << (candidate == message ? "true" : "false");
      decodeInto(candidate, master, slave, out);
      ostringstream csv;
      candidate->dump(nullptr, false, OF_NONE, &csv);
      out << ",\"csv\":\"" << jsonEscape(csv.str()) << "\"";
      vector<Message*> siblings = candidates->siblings(candidate);
      if (!siblings.empty()) {
        out << ",\"siblings\":[";
        bool firstSibling = true;
        for (Message* sibling : siblings) {
          out << (firstSibling ? "{" : ",{");
          firstSibling = false;
          describe(sibling, out);
          ostringstream siblingCsv;
          sibling->dump(nullptr, false, OF_NONE, &siblingCsv);
          out << ",\"csv\":\"" << jsonEscape(siblingCsv.str()) << "\"}";
        }
        out << "]";
      }
      out << "}";
      cout << out.str();
    }
    cout << "]";
  }
  cout << "}\n";
}

int main(int argc, char** argv) {
  string configPath = "/config", lang;
  vector<string> files, messagesArgs;
  bool verbose = false, dump = false, readStdin = false, withCandidates = false;
  for (int i = 1; i < argc; i++) {
    string a = argv[i];
    if (a.compare(0, 13, "--configpath=") == 0) configPath = a.substr(13);
    else if (a.compare(0, 7, "--lang=") == 0) lang = a.substr(7);
    else if (a.compare(0, 7, "--file=") == 0) files.push_back(a.substr(7));
    else if (a == "--verbose") verbose = true;
    else if (a == "--debug") setFacilitiesLogLevel((1 << lf_COUNT) - 1, ll_debug);
    else if (a == "--dump") dump = true;
    else if (a == "--candidates") withCandidates = true;
    else if (a == "-") readStdin = true;
    else if (a.compare(0, 2, "--") == 0) { std::cerr << "unknown option " << a << "\n"; return 2; }
    else messagesArgs.push_back(a);
  }
  setFacilitiesLogLevel((1 << lf_COUNT) - 1, verbose ? ll_info : ll_error);
  MessageMap messages(true, lang);
  CheckResolver resolver(&messages, configPath, verbose);
  messages.setResolver(&resolver);
  if (files.empty()) {
    resolver.loadAll("");
  } else {
    for (const auto& f : files) resolver.loadFile(f);
  }
  ostringstream instrLog;
  result_t instrResult = messages.executeInstructions(nullptr, &instrLog);
  cout << "{\"loaded\":true,\"messages\":" << messages.size() << ",\"errors\":" << resolver.errors()
       << ",\"instructions\":\"" << jsonEscape(getResultCode(instrResult)) << "\""
       << ",\"maxIdLength\":" << messages.getMaxIdLength() << ",\"files\":[";
  bool first = true;
  for (const auto& f : resolver.loaded()) { cout << (first ? "\"" : ",\"") << jsonEscape(f) << "\""; first = false; }
  cout << "]}\n";
  if (dump) {
    cout << "{\"definitions\":";
    messages.dump(true, OF_DEFINITION | OF_JSON, &cout);
    cout << "}\n";
  }
  Candidates* candidates = withCandidates ? new Candidates(&messages) : nullptr;
  for (const auto& m : messagesArgs) decodeOne(&messages, &resolver, candidates, m);
  if (readStdin || (messagesArgs.empty() && !dump)) {
    string line;
    while (std::getline(std::cin, line)) {
      while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
      if (line.empty() || line[0] == '#') continue;
      decodeOne(&messages, &resolver, candidates, line);
    }
  }
  cout << "{\"scan\":{";
  first = true;
  for (const auto& it : s_idents) {
    cout << (first ? "\"" : ",\"") << hex2(it.first) << "\":{\"manufacturer\":\"" << jsonEscape(it.second.manufacturer)
         << "\",\"ident\":\"" << jsonEscape(it.second.ident) << "\",\"sw\":\"" << jsonEscape(it.second.sw)
         << "\",\"hw\":\"" << jsonEscape(it.second.hw) << "\",\"file\":\"" << jsonEscape(it.second.file) << "\"}";
    first = false;
  }
  cout << "}}\n";
  delete candidates;
  return resolver.errors() ? 1 : 0;
}
