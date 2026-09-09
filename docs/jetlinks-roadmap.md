# jetlinks IoT 移植路线图

本文档规划 zucker-framework Phase 5 的 4 个 IoT 专用包，对标 jetlinks-community 的核心 IoT 组件。

## 概览

Phase 5 是 zucker-framework 的 IoT 扩展层，目标是将 jetlinks 的物联网核心能力移植到 Node.js/TypeScript 技术栈。这 4 个包构成完整的 IoT 平台基础设施：

```
@zucker-framework/things      物模型（设备建模 + 数据存储）
@zucker-framework/gateway     协议网关（设备接入 + 消息编解码）
@zucker-framework/network     网络管理（连接配置 + 证书管理）
@zucker-framework/timeseries  时序数据（多后端时序存储）
```

依赖关系：

```
@zucker-framework/network ← @zucker-framework/gateway ← @zucker-framework/things
                                        ↑
                               @zucker-framework/timeseries
```

---

## @zucker-framework/things — 物模型

### 对标 jetlinks 组件

- `jetlinks-things-component`
- `ThingType` / `ThingTemplate` / `ThingInstance`
- `PropertyMetadata` / `EventMetadata` / `FunctionMetadata`

### 功能范围

| 功能 | 说明 |
|------|------|
| 物模型定义 | ThingType（产品类型）→ ThingInstance（设备实例）两级模型 |
| 属性元数据 | PropertyMetadata：名称、标识、数据类型（int/float/string/bool/enum/struct/array）、读写模式、单位 |
| 事件元数据 | EventMetadata：事件级别（info/warn/alarm）、输出参数定义 |
| 功能元数据 | FunctionMetadata：输入参数、输出参数、是否异步 |
| 属性值存储 | 设备属性最新值读写（PropertyStorage 接口） |
| 事件日志 | 设备事件记录存储（EventStorage 接口） |
| 设备标签 | 自定义标签键值对管理 |
| MetricMetadataManager | 度量指标元数据管理，支持自定义度量维度 |

### 核心接口设计

```typescript
interface ThingType {
  id: string;
  name: string;
  properties: PropertyMetadata[];
  events: EventMetadata[];
  functions: FunctionMetadata[];
}

interface ThingInstance {
  id: string;
  name: string;
  typeId: string;
  state: 'online' | 'offline' | 'notActive';
  configuration: Record<string, unknown>;
  tags: Record<string, string>;
}

interface PropertyMetadata {
  id: string;
  name: string;
  valueType: DataType;
  accessMode: 'read' | 'write' | 'readWrite';
  unit?: string;
  description?: string;
}

interface PropertyStorage {
  saveProperty(instanceId: string, property: string, value: unknown, timestamp: number): Promise<void>;
  getProperty(instanceId: string, property: string): Promise<{ value: unknown; timestamp: number } | null>;
  getProperties(instanceId: string): Promise<Record<string, { value: unknown; timestamp: number }>>;
}
```

### 预估工作量

**2-3 周**

- 物模型 CRUD + 验证：1 周
- 属性/事件存储接口 + Prisma 实现：1 周
- MetricMetadataManager + 标签管理：0.5 周

---

## @zucker-framework/gateway — 协议网关

### 对标 jetlinks 组件

- `jetlinks-gateway-component`
- `DeviceGateway` / `DeviceSession`
- `ProtocolSupport` / `MessageCodec`
- `jetlinks-supports`（各协议实现）

### 功能范围

| 功能 | 说明 |
|------|------|
| DeviceGateway 接口 | 设备接入网关抽象，管理设备连接生命周期 |
| 协议编解码 | MessageCodec 接口：encode（平台→设备）+ decode（设备→平台） |
| 会话管理 | DeviceSession：连接状态、心跳检测、超时断开 |
| 消息路由 | 设备消息路由到 TopicEventBus |
| MQTT 网关 | MQTT broker + 客户端管理 |
| HTTP 网关 | HTTP 推送接入 |
| WebSocket 网关 | WebSocket 长连接接入 |
| TCP 网关 | 原始 TCP 连接接入 |
| CoAP 网关 | CoAP 协议接入（轻量级 IoT） |

### 核心接口设计

```typescript
interface DeviceGateway {
  id: string;
  transport: Transport;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  onDeviceConnect(handler: (session: DeviceSession) => void): void;
  onDeviceMessage(handler: (session: DeviceSession, message: DeviceMessage) => void): void;
}

interface MessageCodec {
  transport: Transport;
  decode(context: MessageDecodeContext): Promise<DeviceMessage[]>;
  encode(context: MessageEncodeContext): Promise<EncodedMessage>;
}

interface DeviceSession {
  deviceId: string;
  transport: Transport;
  connectTime: Date;
  lastPingTime: Date;
  send(message: EncodedMessage): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
}

type Transport = 'MQTT' | 'HTTP' | 'WebSocket' | 'TCP' | 'CoAP';
```

### 技术难点

#### MQTT Broker

jetlinks 使用 Netty 实现高性能 MQTT broker。Node.js 方案：

- **Aedes**：纯 Node.js MQTT broker，API 简洁，适合中小规模（数千设备）
- **Mosquitto + 桥接**：大规模场景用 Mosquitto 原生 broker，Node.js 作为桥接层
- 建议：默认用 Aedes，提供 Mosquitto 桥接方案作为生产级替代

#### TCP 粘包处理

jetlinks 用 Netty 的 ByteBuf + ChannelPipeline 处理。Node.js 方案：
- 使用 `net.Socket` + 自定义帧解析器（长度前缀 / 分隔符）
- 可参考 `mqtt-packet` 的流式解析模式

#### CoAP

- 使用 `node-coap` 库，社区活跃度一般但功能完整

### 预估工作量

**4-5 周**

- DeviceGateway + Session + MessageCodec 接口：1 周
- MQTT 网关（Aedes 集成）：1.5 周
- HTTP + WebSocket 网关：1 周
- TCP 网关 + 帧解析：1 周
- 消息路由 + TopicEventBus 集成：0.5 周

---

## @zucker-framework/timeseries — 时序数据

### 对标 jetlinks 组件

- `jetlinks-timeseries-component`
- `TimeSeriesService` / `TimeSeriesManager`
- ElasticSearch 实现 / TDengine 实现

### 功能范围

| 功能 | 说明 |
|------|------|
| TimeSeriesService 接口 | 统一时序数据读写抽象 |
| 数据写入 | 单条写入 + 批量写入 + 流式写入 |
| 数据查询 | 时间范围查询 + 聚合（avg/max/min/sum/count）+ 降采样 |
| 多后端支持 | 可插拔存储后端 |
| 数据保留策略 | TTL 自动清理 + 降采样归档 |

### 核心接口设计

```typescript
interface TimeSeriesService {
  save(metric: string, data: TimeSeriesData): Promise<void>;
  saveBatch(metric: string, data: TimeSeriesData[]): Promise<void>;
  query(metric: string, query: TimeSeriesQuery): Promise<TimeSeriesData[]>;
  aggregate(metric: string, query: AggregateQuery): Promise<AggregateResult[]>;
  delete(metric: string, timeRange: TimeRange): Promise<number>;
}

interface TimeSeriesData {
  timestamp: number;
  values: Record<string, number | string | boolean>;
  tags?: Record<string, string>;
}

interface TimeSeriesQuery {
  timeRange: TimeRange;
  filters?: Record<string, unknown>;
  limit?: number;
  orderBy?: 'asc' | 'desc';
}

interface AggregateQuery extends TimeSeriesQuery {
  interval: string;  // '1m' | '5m' | '1h' | '1d'
  aggregations: Array<{
    field: string;
    function: 'avg' | 'max' | 'min' | 'sum' | 'count' | 'first' | 'last';
    alias?: string;
  }>;
}
```

### 存储后端选型

| 后端 | 优势 | 劣势 | 推荐场景 |
|------|------|------|----------|
| **TimescaleDB** | PostgreSQL 扩展，SQL 兼容，与 Prisma 生态一致 | 超大规模写入性能不如专用 TSDB | 默认推荐，中小规模 |
| **TDengine** | 高压缩比，写入性能极强，支持 SQL | Node.js 驱动不够成熟 | 大规模 IoT 数据 |
| **InfluxDB** | 社区成熟，Node.js SDK 完善 | OSS 版功能受限 | 已有 InfluxDB 基础设施的团队 |
| **Elasticsearch** | jetlinks 默认后端，全文检索能力强 | 存储成本高，聚合查询性能一般 | 需要复杂查询的场景 |

**建议**：默认实现 TimescaleDB（PostgreSQL 扩展，复用现有基础设施），次选 TDengine。

### 预估工作量

**2-3 周**

- TimeSeriesService 接口 + 查询 DSL：0.5 周
- TimescaleDB 实现（hypertable + continuous aggregates）：1.5 周
- 数据保留策略 + 降采样：0.5 周
- TDengine 实现（可选）：1 周

---

## @zucker-framework/network — 网络管理

### 对标 jetlinks 组件

- `jetlinks-network-component`
- `NetworkManager` / `Network` / `NetworkConfig`
- `CertificateManager`

### 功能范围

| 功能 | 说明 |
|------|------|
| NetworkConfig | 网络配置管理（端口、TLS、超时等） |
| Transport 抽象 | TCP / UDP / HTTP / WebSocket / MQTT transport 统一抽象 |
| 证书管理 | TLS 证书上传、存储、关联设备 |
| 网络监控 | 连接数统计、流量统计、错误率 |

### 核心接口设计

```typescript
interface NetworkConfig {
  id: string;
  name: string;
  transport: Transport;
  host: string;
  port: number;
  tls?: TlsConfig;
  options?: Record<string, unknown>;
}

interface TlsConfig {
  certificateId: string;
  clientAuth?: boolean;
}

interface NetworkManager {
  create(config: NetworkConfig): Promise<void>;
  start(id: string): Promise<void>;
  shutdown(id: string): Promise<void>;
  getStatus(id: string): Promise<NetworkStatus>;
  reload(id: string): Promise<void>;
}

interface CertificateManager {
  save(cert: Certificate): Promise<void>;
  get(id: string): Promise<Certificate>;
  delete(id: string): Promise<void>;
  getTlsContext(certId: string): Promise<tls.SecureContext>;
}
```

### 预估工作量

**1.5-2 周**

- NetworkConfig CRUD + NetworkManager：0.5 周
- CertificateManager + TLS 集成：0.5 周
- Transport 抽象 + 各协议适配：0.5 周
- 网络监控指标：0.5 周

---

## 优先级建议

### 推荐实施顺序

```
1. @zucker-framework/things      (基础，其他包都依赖物模型)
2. @zucker-framework/timeseries  (属性/事件存储依赖时序数据)
3. @zucker-framework/network     (网关依赖网络管理)
4. @zucker-framework/gateway     (最复杂，最后实现)
```

### 理由

1. **@zucker-framework/things 优先**：物模型是 IoT 平台的核心数据模型，gateway 和 timeseries 都围绕物模型工作。即使没有网关，也可以通过 HTTP API 手动上报设备数据进行验证。

2. **@zucker-framework/timeseries 第二**：things 的属性值和事件日志需要时序存储。TimescaleDB 方案可以复用现有 PostgreSQL 基础设施，风险最低。

3. **@zucker-framework/network 第三**：网络配置和证书管理相对独立，工作量小，但是 gateway 的前置依赖。

4. **@zucker-framework/gateway 最后**：最复杂的包，涉及多协议实现和会话管理。建议先实现 MQTT 网关（IoT 最常用协议），其他协议后续迭代。

### 总预估工作量

| 包 | 工期 |
|---|---|
| @zucker-framework/things | 2-3 周 |
| @zucker-framework/timeseries | 2-3 周 |
| @zucker-framework/network | 1.5-2 周 |
| @zucker-framework/gateway | 4-5 周 |
| **总计** | **10-13 周** |

### MVP 策略

如果需要快速验证，可以先实现最小可用集：

1. **@zucker-framework/things**：完整物模型 + PostgreSQL 属性存储（不依赖时序数据库）
2. **@zucker-framework/gateway**：仅 MQTT 网关（Aedes）+ HTTP 推送
3. 跳过 @zucker-framework/timeseries 和 @zucker-framework/network，后续补充

MVP 工期：**4-5 周**，可以支撑基本的设备接入 → 数据上报 → 属性读写场景。
