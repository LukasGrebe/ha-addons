// Single-threaded WebAssembly build: the mutex functions used by ebusd's Mutex class are no-ops.
#include <pthread.h>
extern "C" {
int pthread_mutexattr_init(pthread_mutexattr_t*) { return 0; }
int pthread_mutexattr_settype(pthread_mutexattr_t*, int) { return 0; }
int pthread_mutexattr_destroy(pthread_mutexattr_t*) { return 0; }
int pthread_mutex_init(pthread_mutex_t*, const pthread_mutexattr_t*) { return 0; }
int pthread_mutex_destroy(pthread_mutex_t*) { return 0; }
int pthread_mutex_lock(pthread_mutex_t*) { return 0; }
int pthread_mutex_unlock(pthread_mutex_t*) { return 0; }
}
