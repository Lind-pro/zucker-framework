/**
 * 网络组件类型标识。
 *
 * 对应 jetlinks NetworkType — 用于区分 TCP / HTTP / MQTT / WebSocket 等
 * 不同网络组件，以字符串 id 作为唯一键。
 *
 * 与 jetlinks 的差异：去掉了 Java 枚举字典依赖，改用纯接口 + 工厂函数。
 */
export interface NetworkType {
  /** 类型唯一标识，如 'TCP_SERVER'、'HTTP_CLIENT' */
  readonly id: string;
  /** 可读名称（可选，默认等于 id） */
  readonly name: string;
}

/**
 * 用 id 创建一个 NetworkType（等价 jetlinks `NetworkType.of(id)`）。
 */
export function networkType(id: string, name?: string): NetworkType {
  return { id, name: name ?? id };
}

/**
 * 内置网络类型常量，对应 jetlinks DefaultNetworkType 的通用子集。
 * IoT 专用类型（CoAP 等）不迁移。
 */
export const NetworkTypes = {
  TCP_CLIENT: networkType('TCP_CLIENT', 'TCP Client'),
  TCP_SERVER: networkType('TCP_SERVER', 'TCP Server'),
  HTTP_CLIENT: networkType('HTTP_CLIENT', 'HTTP Client'),
  HTTP_SERVER: networkType('HTTP_SERVER', 'HTTP Server'),
  MQTT_CLIENT: networkType('MQTT_CLIENT', 'MQTT Client'),
  MQTT_SERVER: networkType('MQTT_SERVER', 'MQTT Server'),
  WEB_SOCKET_CLIENT: networkType('WEB_SOCKET_CLIENT', 'WebSocket Client'),
  WEB_SOCKET_SERVER: networkType('WEB_SOCKET_SERVER', 'WebSocket Server'),
  UDP: networkType('UDP', 'UDP'),
} as const;

/**
 * 动态类型注册表 — 对齐 jetlinks NetworkTypes 的 register/lookup 模式。
 *
 * 允许运行时注册自定义网络类型（如 CoAP、自定义协议等），
 * 与 jetlinks 中 NetworkTypes.register() 语义一致。
 */
class NetworkTypeRegistry {
  private readonly types = new Map<string, NetworkType>();

  constructor() {
    // 注册内置类型
    for (const t of Object.values(NetworkTypes)) {
      this.types.set(t.id.toUpperCase(), t);
    }
  }

  /** 注册网络类型 — 对齐 jetlinks NetworkTypes.register() */
  register(type: NetworkType): void {
    this.types.set(type.id.toUpperCase(), type);
  }

  /** 批量注册 */
  registerAll(types: NetworkType[]): void {
    for (const t of types) {
      this.register(t);
    }
  }

  /** 根据 ID 查找网络类型 — 对齐 jetlinks NetworkTypes.lookup() */
  lookup(id: string): NetworkType | undefined {
    return this.types.get(id.toUpperCase());
  }

  /** 获取所有已注册的网络类型 — 对齐 jetlinks NetworkTypes.get() */
  getAll(): NetworkType[] {
    return Array.from(this.types.values());
  }
}

/** 全局网络类型注册表单例 */
export const networkTypeRegistry = new NetworkTypeRegistry();
