
/**
 * Loon Smart Select
 * Low latency + High throughput
 *
 * Requirements:
 * Loon Script API:
 * $config.getSubPolicies()
 * $config.getSelectedPolicy()
 * $config.setSelectPolicy()
 * $httpClient.get()
 * $persistentStore
 */

const CONFIG = {
  policyGroup: "AutoVelocity",

  // Latency threshold
  latencyTolerance: 30,

  // Latency probes per node
  latencyRounds: 3,

  // Request timeout
  requestTimeout: 12000,

  // Download test
  downloadBytes: 5000000,
  downloadTimeout: 25000,

  // Switch protection
  speedImprovement: 1.20,
  consecutiveWins: 2,

  // Cloudflare test endpoints
  latencyURL: "https://cp.cloudflare.com/generate_204",
  downloadURL: "https://speed.cloudflare.com/__down?bytes=5000000",

  storageKey: "loon_smart_select_v1"
};

let finished = false;

function finish(message) {
  if (finished) return;
  finished = true;

  console.log(message);
  $done();
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getNodeName(item) {
  if (typeof item === "string") return item;

  if (item && typeof item === "object") {
    return item.name || item.policy || item.node || "";
  }

  return "";
}

function requestLatency(node, callback) {
  const samples = [];
  let round = 0;

  function next() {
    if (round >= CONFIG.latencyRounds) {
      callback(samples.length
        ? median(samples)
        : null);
      return;
    }

    round++;

    const start = Date.now();

    $httpClient.get({
      url: CONFIG.latencyURL,
      node: node,
      timeout: CONFIG.requestTimeout,
      headers: {
        "Cache-Control": "no-cache"
      }
    }, function(error, response) {
      const elapsed = Date.now() - start;

      if (
        !error &&
        response &&
        response.status >= 200 &&
        response.status < 400
      ) {
        samples.push(elapsed);
      }

      next();
    });
  }

  next();
}

function requestSpeed(node, callback) {
  const start = Date.now();

  const url =
    CONFIG.downloadURL +
    "&_t=" + Date.now() + Math.random();

  $httpClient.get({
    url: url,
    node: node,
    timeout: CONFIG.downloadTimeout,
    "binary-mode": true,
    headers: {
      "Cache-Control": "no-cache"
    }
  }, function(error, response, data) {
    const elapsed = Date.now() - start;

    if (
      error ||
      !response ||
      response.status !== 200 ||
      !data ||
      !data.length ||
      elapsed <= 0
    ) {
      callback(null);
      return;
    }

    const bytes = data.length;

    // Mbps = bytes * 8 / milliseconds / 1000
    const mbps = bytes * 8 / elapsed / 1000;

    callback({
      mbps: mbps,
      bytes: bytes,
      elapsed: elapsed
    });
  });
}

function readHistory() {
  try {
    return JSON.parse(
      $persistentStore.read(CONFIG.storageKey) || "{}"
    );
  } catch (e) {
    return {};
  }
}

function saveHistory(data) {
  $persistentStore.write(
    JSON.stringify(data),
    CONFIG.storageKey
  );
}

function switchNode(node, current, reason) {
  const success = $config.setSelectPolicy(
    CONFIG.policyGroup,
    node
  );

  if (success) {
    $notification.post(
      "Loon 智能选路",
      "节点已切换",
      current + " → " + node + "\n" + reason
    );
  }

  finish({
    action: success ? "switch" : "switch_failed",
    previous: current,
    selected: node,
    reason: reason
  });
}

function runSpeedTests(candidates, callback) {
  const results = [];
  let index = 0;

  function next() {
    if (index >= candidates.length) {
      callback(results);
      return;
    }

    const candidate = candidates[index++];

    requestSpeed(candidate.name, function(speed) {
      if (speed) {
        results.push({
          name: candidate.name,
          latency: candidate.latency,
          speed: speed.mbps
        });
      }

      console.log({
        stage: "bandwidth",
        node: candidate.name,
        latency: candidate.latency,
        speed: speed ? speed.mbps : null
      });

      next();
    });
  }

  next();
}

function chooseBest(results, current) {
  if (!results.length) {
    finish("No valid bandwidth results. Keep current node.");
    return;
  }

  results.sort((a, b) => b.speed - a.speed);

  const best = results[0];

  const currentResult = results.find(
    item => item.name === current
  );

  console.log({
    stage: "ranking",
    results: results
  });

  // Current node is outside the latency window.
  if (!currentResult) {
    switchNode(
      best.name,
      current,
      "当前节点不在低延迟候选区间，选择最快节点"
    );
    return;
  }

  // Already using the fastest node.
  if (best.name === current) {
    saveHistory({});
    finish("Current node is already the fastest candidate.");
    return;
  }

  const requiredSpeed =
    currentResult.speed * CONFIG.speedImprovement;

  if (best.speed < requiredSpeed) {
    saveHistory({});
    finish(
      "Speed improvement below 20%. Keep current node."
    );
    return;
  }

  const history = readHistory();

  if (history.pendingNode === best.name) {
    history.pendingCount =
      (history.pendingCount || 0) + 1;
  } else {
    history.pendingNode = best.name;
    history.pendingCount = 1;
  }

  saveHistory(history);

  if (history.pendingCount >= CONFIG.consecutiveWins) {
    saveHistory({});

    switchNode(
      best.name,
      current,
      "连续两轮胜出，下载速度提升 " +
      (best.speed / currentResult.speed * 100 - 100).toFixed(1) +
      "%"
    );

    return;
  }

  finish({
    action: "wait_confirmation",
    current: current,
    candidate: best.name,
    currentSpeed: currentResult.speed,
    candidateSpeed: best.speed,
    consecutiveWins: history.pendingCount
  });
}

function start() {
  const group = CONFIG.policyGroup;
  const current = $config.getSelectedPolicy(group);

  if (!current) {
    finish("Cannot read current policy. Check group name.");
    return;
  }

  $config.getSubPolicies(group, function(text) {
    let rawNodes;

    try {
      rawNodes = text ? JSON.parse(text) : [];
    } catch (e) {
      finish("Failed to parse policy group: " + e);
      return;
    }

    const nodes = rawNodes
      .map(getNodeName)
      .filter(name =>
        name &&
        name !== "DIRECT" &&
        name !== "REJECT" &&
        name !== "REJECT-DROP"
      );

    if (!nodes.length) {
      finish("No available nodes in policy group.");
      return;
    }

    console.log({
      stage: "start",
      group: group,
      current: current,
      totalNodes: nodes.length
    });

    const latencyResults = [];
    let index = 0;

    function testNextNode() {
      if (index >= nodes.length) {
        finishLatency();
        return;
      }

      const node = nodes[index++];

      requestLatency(node, function(latency) {
        if (latency !== null) {
          latencyResults.push({
            name: node,
            latency: latency
          });
        }

        console.log({
          stage: "latency",
          node: node,
          latency: latency
        });

        testNextNode();
      });
    }

    function finishLatency() {
      if (!latencyResults.length) {
        finish("All latency tests failed. Keep current node.");
        return;
      }

      const minLatency = Math.min.apply(
        null,
        latencyResults.map(item => item.latency)
      );

      const threshold =
        minLatency + CONFIG.latencyTolerance;

      const candidates = latencyResults.filter(
        item => item.latency <= threshold
      );

      console.log({
        stage: "filter",
        minLatency: minLatency,
        threshold: threshold,
        candidates: candidates
      });

      runSpeedTests(candidates, function(results) {
        chooseBest(results, current);
      });
    }

    testNextNode();
  });
}

start();
