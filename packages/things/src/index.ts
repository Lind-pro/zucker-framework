// 数据类型系统
export type {
  DataType,
  DataTypeId,
  StringDataType,
  IntDataType,
  LongDataType,
  FloatDataType,
  DoubleDataType,
  BooleanDataType,
  EnumDataType,
  DateDataType,
  ObjectDataType,
  ArrayDataType,
  GeoDataType,
  PasswordDataType,
  FileDataType,
  EnumElement,
  GeoPoint,
  PropertyMetadataInput,
} from './data-type';
export { convertValue } from './data-type';

// 物模型元数据
export type {
  PropertyMetadata,
  FunctionMetadata,
  FunctionParameter,
  EventMetadata,
  ThingMetadata,
} from './metadata';
export {
  PropertyAccessMode,
  EventLevel,
  mergeMetadata,
  createMetadata,
} from './metadata';

// 物类型 & 实例
export type {
  ThingType,
  Thing,
  ThingManager,
} from './thing';
export { ThingState } from './thing';

// 内存实现
export { InMemoryThingManager } from './thing-manager';

// 消息体系
export type {
  ThingMessage,
  ThingMessageType,
  ReportPropertyMessage,
  EventMessage,
  FunctionReplyMessage,
  RegisterMessage,
  UnregisterMessage,
  OnlineMessage,
  OfflineMessage,
  ReportTagsMessage,
  ReadPropertyReplyMessage,
  ReadPropertyMessage,
  WritePropertyMessage,
  FunctionInvokeMessage,
  UpstreamMessage,
  DownstreamMessage,
} from './message';
export {
  createMessageId,
  createReportPropertyMessage,
  createEventMessage,
} from './message';

// 属性/事件日志存储
export type {
  PropertyLog,
  EventLog,
  ThingLogQuery,
  ThingsDataService,
} from './property-log';
export { DefaultThingsDataService } from './property-log';

// NestJS 模块
export { ThingsModule } from './things.module';
