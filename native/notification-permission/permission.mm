#include <node_api.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <atomic>
#include <memory>

struct Result {
  std::atomic<int> status{-1};
  dispatch_semaphore_t ready = dispatch_semaphore_create(0);
};
struct Query {
  napi_async_work work;
  napi_deferred deferred;
  int permission = -1;
  std::shared_ptr<Result> result = std::make_shared<Result>();
};
static void Execute(napi_env, void* data) {
  auto query = static_cast<Query*>(data);
  auto result = query->result;
  @autoreleasepool {
    @try {
      // This check executes inside Her, not a helper process or browser.
      if (![[NSBundle mainBundle].bundleIdentifier isEqualToString:@"com.her.desktop"]) return;
      [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
        result->status.store((int)settings.authorizationStatus);
        dispatch_semaphore_signal(result->ready);
      }];
      if (dispatch_semaphore_wait(result->ready, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) == 0)
        query->permission = result->status.load();
    } @catch (NSException*) { result->status.store(-1); }
  }
}
static void Complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Query> query(static_cast<Query*>(data));
  if (!env) return;
  int permission = status == napi_ok ? query->permission : -1;
  const char* value = permission == UNAuthorizationStatusAuthorized ? "authorized"
    : permission == UNAuthorizationStatusDenied ? "denied"
    : permission == UNAuthorizationStatusNotDetermined ? "not-determined" : "unknown";
  napi_value result;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  napi_resolve_deferred(env, query->deferred, result);
  napi_delete_async_work(env, query->work);
}
static napi_value QueryPermission(napi_env env, napi_callback_info) {
  auto query = std::make_unique<Query>();
  napi_value promise, name;
  if (napi_create_promise(env, &query->deferred, &promise) != napi_ok) return nullptr;
  napi_create_string_utf8(env, "HerNotificationPermission", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, Execute, Complete, query.get(), &query->work) != napi_ok) {
    napi_throw_error(env, nullptr, "Permission query unavailable"); return nullptr;
  }
  if (napi_queue_async_work(env, query->work) != napi_ok) {
    napi_delete_async_work(env, query->work);
    napi_throw_error(env, nullptr, "Permission query unavailable"); return nullptr;
  }
  query.release();
  return promise;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value query;
  napi_create_function(env, "query", NAPI_AUTO_LENGTH, QueryPermission, nullptr, &query);
  napi_set_named_property(env, exports, "query", query);
  return exports;
}
NAPI_MODULE(notification_permission, Init)
