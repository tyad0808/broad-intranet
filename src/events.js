// 실시간 통로 (Server-Sent Events)
// 브라우저가 /events 에 연결해 두면, 서버가 "주문이 바뀌었다", "신규 발주" 같은 소식을 바로 밀어 보낸다.
// 웹소켓보다 단순하고, 서버 → 브라우저 한 방향이면 충분해서 이 방식을 쓴다.

class EventHub {
  constructor({ heartbeatMs = 25_000 } = {}) {
    this.clients = new Set();
    // 아무 소식이 없어도 25초마다 신호를 보내 연결이 끊기지 않게 한다 (프록시·공유기가 조용한 연결을 끊는 것 방지)
    this.timer = setInterval(() => this.broadcastRaw(': ping\n\n'), heartbeatMs);
    this.timer.unref();
  }

  add(req, res, userId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Nginx 가 모아서 늦게 보내지 않도록
    });
    res.write('retry: 5000\n\n'); // 끊기면 5초 뒤 자동 재연결
    const client = { res, userId };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
    return client;
  }

  // canReceive(userId) 가 true 인 연결에만 보낸다
  send(event, data, canReceive = () => true) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (canReceive(client.userId)) client.res.write(payload);
    }
  }

  broadcastRaw(text) {
    for (const client of this.clients) client.res.write(text);
  }

  // 계정 정지·거절 시 그 직원의 실시간 연결도 끊는다
  disconnectUser(userId) {
    for (const client of this.clients) {
      if (client.userId === userId) {
        client.res.end();
        this.clients.delete(client);
      }
    }
  }

  close() {
    clearInterval(this.timer);
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }
}

module.exports = { EventHub };
