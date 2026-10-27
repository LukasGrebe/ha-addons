// ebusd-check: load ebusd CSV message definitions and decode telegrams with ebusd's own
// message library. Built to WebAssembly (wasm32-wasi) so it can run in the browser.
//
// usage: ebusd-check [--configpath=DIR] [--lang=LANG] [--file=REL.csv]... [--verbose] [--dump] [MESSAGE|-]...
//   MESSAGE is a telegram as QQZZPBSBNNDD/NNDD (slave part may be empty), "-" reads one per line from stdin.
// Output: one JSON object per line on stdout; log lines on stderr.
#include <dirent.h>
#include <sys/stat.h>
#include <cstring>
#include <iostream>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>
#include "lib/ebus/data.h"
#include "lib/ebus/filereader.h"
#include "lib/ebus/message.h"
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
    } else {
      logError(lf_main, "error reading file %s: %s, %s", relFile.c_str(), getResultCode(result), errorDescription.c_str());
      m_errors++;
    }
    return result;
  }

  /** Load all CSV files of a directory like "ebusd --checkconfig" does (recursively). */
  void loadAll(const string& relPath) {
    string path = m_configPath + (relPath.empty() ? "" : "/" + relPath);
    DIR* dir = opendir(path.c_str());
    if (!dir) { logError(lf_main, "unable to read directory %s", path.c_str()); m_errors++; return; }
    vector<string> files, dirs;
    dirent* d;
    while ((d = readdir(dir)) != nullptr) {
      string name = d->d_name;
      if (name == "." || name == ".." || name == "_templates.csv") continue;
      struct stat st;
      if (stat((path + "/" + name).c_str(), &st) != 0) continue;
      string rel = relPath.empty() ? name : relPath + "/" + name;
      if (S_ISDIR(st.st_mode)) dirs.push_back(rel);
      else if (name.size() > 4 && name.compare(name.size() - 4, 4, ".csv") == 0) files.push_back(rel);
    }
    closedir(dir);
    std::sort(files.begin(), files.end());
    std::sort(dirs.begin(), dirs.end());
    readTemplates(relPath);
    for (const auto& f : files) loadFile(f);
    for (const auto& sub : dirs) loadAll(sub);
  }

  int errors() const { return m_errors; }

 private:
  MessageMap* m_messages;
  string m_configPath;
  bool m_verbose;
  DataFieldTemplates m_globalTemplates;
  map<string, DataFieldTemplates*> m_templatesByPath;
  int m_errors = 0;
};

static void decodeOne(MessageMap* messages, const string& arg) {
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
  Message* message = messages->find(master);
  if (!message) {
    cout << ",\"found\":false}\n";
    return;
  }
  cout << ",\"found\":true,\"circuit\":\"" << jsonEscape(message->getCircuit()) << "\",\"name\":\""
       << jsonEscape(message->getName()) << "\",\"write\":" << (message->isWrite() ? "true" : "false")
       << ",\"passive\":" << (message->isPassive() ? "true" : "false")
       << ",\"level\":\"" << jsonEscape(message->getLevel()) << "\"";
  result = message->storeLastData(master, slave);
  if (result == RESULT_OK) {
    ostringstream text;
    result = message->decodeLastData(pt_any, false, nullptr, -1, OF_NAMES | OF_UNITS, &text);
    if (result == RESULT_OK) {
      cout << ",\"text\":\"" << jsonEscape(text.str()) << "\"";
      ostringstream json;
      if (message->decodeLastData(pt_any, false, nullptr, -1, OF_NAMES | OF_UNITS | OF_COMMENTS | OF_JSON | OF_ALL_ATTRS, &json) == RESULT_OK) {
        string fields = json.str();  // ebusd pretty-prints JSON over several lines, keep one line per telegram
        for (char& c : fields) if (c == '\n' || c == '\r') c = ' ';
        cout << ",\"fields\":{" << fields << "}";
      }
    }
  }
  cout << ",\"result\":\"" << (result == RESULT_OK ? "ok" : getResultCode(result)) << "\"}\n";
}

int main(int argc, char** argv) {
  string configPath = "/config", lang;
  vector<string> files, messagesArgs;
  bool verbose = false, dump = false, readStdin = false;
  for (int i = 1; i < argc; i++) {
    string a = argv[i];
    if (a.compare(0, 13, "--configpath=") == 0) configPath = a.substr(13);
    else if (a.compare(0, 7, "--lang=") == 0) lang = a.substr(7);
    else if (a.compare(0, 7, "--file=") == 0) files.push_back(a.substr(7));
    else if (a == "--verbose") verbose = true;
    else if (a == "--debug") setFacilitiesLogLevel((1 << lf_COUNT) - 1, ll_debug);
    else if (a == "--dump") dump = true;
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
       << ",\"maxIdLength\":" << messages.getMaxIdLength() << "}\n";
  if (dump) {
    cout << "{\"definitions\":";
    messages.dump(true, OF_DEFINITION | OF_JSON, &cout);
    cout << "}\n";
  }
  for (const auto& m : messagesArgs) decodeOne(&messages, m);
  if (readStdin || (messagesArgs.empty() && !dump)) {
    string line;
    while (std::getline(std::cin, line)) {
      while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
      if (line.empty() || line[0] == '#') continue;
      decodeOne(&messages, line);
    }
  }
  return resolver.errors() ? 1 : 0;
}
