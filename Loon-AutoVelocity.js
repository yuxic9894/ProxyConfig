
/**
 * AutoVelocity - Loon 自动延迟 + 下载速度择优
 *
 * 流程：
 * 1. 获取 AutoVelocity 下的所有真实节点
 * 2. 并发测试延迟
 * 3. 筛选最低延迟 + 30ms
 * 4. 对候选节点进行下载测速
 * 5. 选择吞吐量最高的节点
 * 6. 自动切换策略组
 */

var GROUP = "AutoVelocity";

// 延迟测速
var LATENCY_BYTES = 1024;
var LATENCY_TIMEOUT = 8000;
var LATENCY_CONCURRENCY = 8;

// 下载测速
var DOWNLOAD_BYTES = 3000000; // 3 MB
var DOWNLOAD_TIMEOUT = 15000;
var DOWNLOAD_CONCURRENCY = 2;

// 自动选路条件
var LATENCY_TOLERANCE = 30;
var MAX_SPEED_TEST_NODES = 12;

// Cloudflare 下载测速端点
var SPEED_URL = "https://speed.cloudflare.com/__down?bytes=";

var finished = false;
var requestId = 0;

function log(message) {
  console.log("[AutoVelocity] " + String(message));
}

function finish() {
  if (finished) return;
  finished = true;
  log("========== 测速任务结束 ==========");
  $done();
}

function getBytes(data) {
  if (data === null || data === undefined) return 0;
  if (typeof data === "string") return data.length;
  if (typeof data.length === "number") return data.length;
  return 0;
}

function makeURL(bytes) {
  requestId++;
  return SPEED_URL + bytes + "&cache=" + Date.now() + "_" + requestId;
}

function requestNode(node, bytes, timeout, callback) {
  var started = Date.now();

  $httpClient.get({
    url: makeURL(bytes),
    node: node,
    timeout: timeout,
    "binary-mode": true
  }, function(error, response, data) {
    var elapsed = Date.now() - started;
    var status = response && response.status ? response.status : 0;
    var received = getBytes(data);

    if (error || status < 200 || status >= 300 || received <= 0) {
      callback({
        ok: false,
        node: node,
        latency: elapsed,
        error: String(error || ("HTTP " + status)),
        bytes: received
      });
      return;
    }

    callback({
      ok: true,
      node: node,
      latency: elapsed,
      bytes: received
    });
  });
}

// 并发任务队列
function runPool(items, concurrency, worker, complete) {
  var index = 0;
  var active = 0;
  var completed = 0;
  var results = [];

  if (items.length === 0) {
    complete(results);
    return;
  }

  function pump() {
    while (active < concurrency && index < items.length) {
      (function(item, currentIndex) {
        active++;

        worker(item, function(result) {
          results[currentIndex] = result;
          active--;
          completed++;

          if (completed === items.length) {
            complete(results);
          } else {
            pump();
          }
        });
      })(items[index], index);

      index++;
    }
  }

  pump();
}

function getNodeNames(items) {
  var result = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];

    if (typeof item === "string") {
      if (item.length > 0) result.push(item);
    } else if (item && item.type === "node" && item.name) {
      result.push(item.name);
    }
  }

  return result;
}

function startDownloadTests(candidates, currentSelected) {
  log("进入下载速度测试阶段");
  log("符合延迟条件的节点数: " + candidates.length);

  candidates.sort(function(a, b) {
    return a.latency - b.latency;
  });

  if (candidates.length > MAX_SPEED_TEST_NODES) {
    log(
      "候选节点超过限制，按延迟选取前 " +
      MAX_SPEED_TEST_NODES +
      " 个"
    );

    candidates = candidates.slice(0, MAX_SPEED_TEST_NODES);
  }

  log("实际下载测速节点数: " + candidates.length);
  log("单节点下载测试大小: " + DOWNLOAD_BYTES + " bytes");

  runPool(
    candidates,
    DOWNLOAD_CONCURRENCY,
    function(item, callback) {
      log("下载测速: " + item.node);

      requestNode(
        item.node,
        DOWNLOAD_BYTES,
        DOWNLOAD_TIMEOUT,
        function(result) {
          if (!result.ok) {
            log(
              "下载失败: " + item.node +
              " | " + result.error
            );

            callback({
              ok: false,
              node: item.node,
              latency: item.latency,
              speed: 0,
              bytes: result.bytes
            });

            return;
          }

          // Mbps = bytes * 8 / milliseconds / 1000
          var speed = result.bytes * 8 / result.latency / 1000;

          log(
            "下载结果: " + item.node +
            " | 延迟 " + item.latency + " ms" +
            " | 速度 " + speed.toFixed(2) + " Mbps"
          );

          callback({
            ok: true,
            node: item.node,
            latency: item.latency,
            speed: speed,
            bytes: result.bytes
          });
        }
      );
    },
    function(speedResults) {
      var valid = [];

      for (var i = 0; i < speedResults.length; i++) {
        if (speedResults[i] && speedResults[i].ok) {
          valid.push(speedResults[i]);
        }
      }

      if (valid.length === 0) {
        log("所有候选节点下载测速失败，不切换节点");
        finish();
        return;
      }

      valid.sort(function(a, b) {
        return b.speed - a.speed;
      });

      var best = valid[0];

      log("========== 下载测速排名 ==========");

      for (var j = 0; j < valid.length; j++) {
        log(
          (j + 1) + ". " + valid[j].node +
          " | " + valid[j].speed.toFixed(2) + " Mbps" +
          " | 延迟 " + valid[j].latency + " ms"
        );
      }

      log("最快节点: " + best.node);
      log("最快速度: " + best.speed.toFixed(2) + " Mbps");

      if (currentSelected === best.node) {
        log("当前已经是最快节点，无需切换");
      } else {
        var changed = $config.setSelectPolicy(GROUP, best.node);

        log("切换操作返回: " + String(changed));

        if (changed) {
          log("已切换至: " + best.node);
        } else {
          log("切换失败，请检查策略组和节点名称");
        }
      }

      var summary = {
        time: new Date().toISOString(),
        group: GROUP,
        selected: best.node,
        speedMbps: best.speed,
        latencyMs: best.latency,
        tested: valid.length,
        results: valid
      };

      $persistentStore.write(
        JSON.stringify(summary),
        "AutoVelocity_LastResult"
      );

      log("测速结果已保存");
      finish();
    }
  );
}

function startLatencyTests(nodes) {
  log("开始延迟测试，总节点数: " + nodes.length);

  runPool(
    nodes,
    LATENCY_CONCURRENCY,
    function(node, callback) {
      requestNode(
        node,
        LATENCY_BYTES,
        LATENCY_TIMEOUT,
        function(result) {
          if (result.ok) {
            log(
              "延迟: " + node +
              " | " + result.latency + " ms"
            );

            callback({
              ok: true,
              node: node,
              latency: result.latency
            });
          } else {
            log(
              "延迟测试失败: " + node +
              " | " + result.error
            );

            callback({
              ok: false,
              node: node,
              latency: 0
            });
          }
        }
      );
    },
    function(results) {
      var valid = [];

      for (var i = 0; i < results.length; i++) {
        if (results[i] && results[i].ok) {
          valid.push(results[i]);
        }
      }

      if (valid.length === 0) {
        log("没有可用节点，终止测速");
        finish();
        return;
      }

      valid.sort(function(a, b) {
        return a.latency - b.latency;
      });

      var minLatency = valid[0].latency;
      var threshold = minLatency + LATENCY_TOLERANCE;
      var candidates = [];

      log("最低延迟: " + minLatency + " ms");
      log("延迟筛选上限: " + threshold + " ms");

      for (var j = 0; j < valid.length; j++) {
        if (valid[j].latency <= threshold) {
          candidates.push(valid[j]);
        }
      }

      log("延迟测试成功: " + valid.length + "/" + nodes.length);
      log("延迟候选节点: " + candidates.length);

      var currentSelected = $config.getSelectedPolicy(GROUP);

      log("当前选择: " + String(currentSelected));

      startDownloadTests(candidates, currentSelected);
    }
  );
}

log("========== AutoVelocity 开始 ==========");
log("设备: " + $loon);
log("策略组: " + GROUP);

try {
  var config = JSON.parse($config.getConfig() || "{}");
  var groups = config.all_policy_groups || [];

  if (groups.indexOf(GROUP) === -1) {
    log("错误：找不到策略组 " + GROUP);
    finish();
  } else {
    $config.getSubPolicies(GROUP, function(text) {
      if (finished) return;

      var items = [];

      try {
        items = JSON.parse(text || "[]");
      } catch (e) {
        log("节点列表解析失败: " + String(e));
        finish();
        return;
      }

      var nodes = getNodeNames(items);

      log("获取到的真实节点数: " + nodes.length);

      if (nodes.length === 0) {
        log("错误：策略组中没有可用节点");
        finish();
        return;
      }

      startLatencyTests(nodes);
    });
  }
} catch (e) {
  log("脚本异常: " + String(e));
  finish();
}
