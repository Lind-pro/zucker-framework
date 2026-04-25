import { describe, it, expect, beforeEach } from 'vitest';
import { EntityEventListenerConfigure } from './entity-event-listener-configure';
import { EntityEventType, EntityEventPhase } from './entity-events';

describe('EntityEventListenerConfigure', () => {
  let configure: EntityEventListenerConfigure;

  beforeEach(() => {
    configure = new EntityEventListenerConfigure();
  });

  it('should enable all events by default', () => {
    expect(configure.isEnabled('user')).toBe(true);
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)).toBe(true);
  });

  it('should disable entity-level events', () => {
    configure.disable('user');
    expect(configure.isEnabled('user')).toBe(false);
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)).toBe(false);
  });

  it('should enable entity-level events after disable', () => {
    configure.disable('user');
    configure.enable('user');
    expect(configure.isEnabled('user')).toBe(true);
  });

  it('should disable specific event type', () => {
    configure.disable('user', EntityEventType.CREATE);
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)).toBe(false);
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.AFTER)).toBe(false);
    // Other event types should remain enabled
    expect(configure.isEnabled('user', EntityEventType.DELETE, EntityEventPhase.BEFORE)).toBe(true);
  });

  it('should disable specific phase', () => {
    configure.disable('user', EntityEventType.CREATE, EntityEventPhase.BEFORE);
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)).toBe(false);
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.AFTER)).toBe(true);
  });

  it('should enable specific phase after disable', () => {
    configure.disable('user', EntityEventType.CREATE);
    configure.enable('user', EntityEventType.CREATE, EntityEventPhase.BEFORE);
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)).toBe(true);
  });

  it('should handle enable/disable mutual exclusion', () => {
    configure.enable('user', EntityEventType.CREATE);
    configure.disable('user', EntityEventType.CREATE);
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)).toBe(false);
  });

  it('should reset entity-level configuration', () => {
    configure.disable('user');
    configure.reset('user');
    expect(configure.isEnabled('user')).toBe(true);
  });

  it('should resetAll configurations', () => {
    configure.disable('user');
    configure.disable('order');
    configure.resetAll();
    expect(configure.isEnabled('user')).toBe(true);
    expect(configure.isEnabled('order')).toBe(true);
  });

  it('should isolate configurations between entity types', () => {
    configure.disable('user');
    expect(configure.isEnabled('user')).toBe(false);
    expect(configure.isEnabled('order')).toBe(true);
  });

  it('should enable multiple phases at once', () => {
    configure.disable('user', EntityEventType.MODIFY);
    configure.enable('user', EntityEventType.MODIFY, EntityEventPhase.BEFORE, EntityEventPhase.AFTER);
    expect(configure.isEnabled('user', EntityEventType.MODIFY, EntityEventPhase.BEFORE)).toBe(true);
    expect(configure.isEnabled('user', EntityEventType.MODIFY, EntityEventPhase.AFTER)).toBe(true);
  });

  it('should entity-level disable override phase-level enable', () => {
    configure.enable('user', EntityEventType.CREATE, EntityEventPhase.BEFORE);
    configure.disable('user');
    expect(configure.isEnabled('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)).toBe(false);
  });
});
