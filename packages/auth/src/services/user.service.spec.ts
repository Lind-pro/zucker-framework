import { describe, it, expect, vi } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { NotFoundException, ValidationException } from '@zucker-framework/core';
import { UserService } from './user.service';
import { ScryptEncoder } from '../password/scrypt-encoder';
import { AUTH_EVENT_TOPICS } from '../events/auth-events';

async function fixture() {
  const db = new InMemoryAdapter();
  const encoder = new ScryptEncoder();
  const bus = { publish: vi.fn().mockResolvedValue(undefined) };
  const service = new UserService(db, encoder, bus);
  const user = await service.addUser({ username: 'fixture', name: 'Fixture', typeId: 'user', password: 'SyntheticOnly9Password' });
  bus.publish.mockClear();
  return { db, encoder, bus, service, user };
}

describe('UserService credential and binding contracts', () => {
  it('keeps the existing encoded password when the same plaintext is resubmitted', async () => {
    const f = await fixture();
    const input = Object.freeze({ id: f.user.id, username: f.user.username, password: 'SyntheticOnly9Password', name: 'Changed' });
    const saved = await f.service.saveUser(input);
    expect(saved.password).toBe(f.user.password);
    expect(saved.name).toBe('Changed');
    expect((await f.service.findById(f.user.id))?.password).toBe(f.user.password);
    expect(f.bus.publish).toHaveBeenCalledWith(AUTH_EVENT_TOPICS.USER_MODIFIED, expect.objectContaining({ passwordChanged: false }));
    expect(JSON.stringify(f.bus.publish.mock.calls)).not.toContain(input.password);
  });

  it('encodes a different password without mutating the caller or exposing credentials in events', async () => {
    const f = await fixture();
    const changes = Object.freeze({ password: 'AnotherSynthetic8Password' });
    const saved = await f.service.updateUser(f.user.id, changes);
    expect(saved.password).not.toBe(changes.password);
    expect(await f.encoder.matches(changes.password, saved.password!)).toBe(true);
    expect(await f.encoder.matches('SyntheticOnly9Password', saved.password!)).toBe(false);
    expect(f.bus.publish).toHaveBeenCalledWith(AUTH_EVENT_TOPICS.USER_MODIFIED, expect.objectContaining({ passwordChanged: true }));
    expect(JSON.stringify(f.bus.publish.mock.calls)).not.toContain(changes.password);
  });

  it.each([undefined, ''])('preserves credentials for partial update with password %s', async password => {
    const f = await fixture();
    const saved = await f.service.updateUser(f.user.id, Object.freeze({ name: 'New name', password, username: undefined }));
    expect(saved.password).toBe(f.user.password);
    expect(saved.username).toBe('fixture');
    expect(saved.name).toBe('New name');
  });

  it('rejects invalid passwords and absent users without writing or emitting mutation events', async () => {
    const f = await fixture();
    await expect(f.service.updateUser(f.user.id, { password: 'x' })).rejects.toThrow();
    await expect(f.service.updateUser('absent', { name: 'New' })).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.service.findById('absent')).toBeNull();
    expect((await f.service.findById(f.user.id))?.password).toBe(f.user.password);
    expect(f.bus.publish).not.toHaveBeenCalled();
  });

  it('deduplicates and replaces role bindings while retaining caller-owned primary key mapping', async () => {
    const f = await fixture();
    await f.db.model('userRoles').create({ data: { userId: f.user.id, roleId: 'old' } });
    await f.service.setUserRoles(f.user.id, ['reader', 'reader', 'editor'], {
      bindingData: (userId, roleId) => ({ id: `${userId}_${roleId}` }),
    });
    expect(await f.db.model('userRoles').findMany({ where: { userId: f.user.id } })).toEqual([
      { id: `${f.user.id}_reader`, userId: f.user.id, roleId: 'reader' },
      { id: `${f.user.id}_editor`, userId: f.user.id, roleId: 'editor' },
    ]);
    expect(f.bus.publish).toHaveBeenCalledWith(AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE, expect.objectContaining({ userId: f.user.id }));
    await f.service.setUserRoles(f.user.id, []);
    expect(await f.db.model('userRoles').findMany({ where: { userId: f.user.id } })).toEqual([]);
  });

  it('rejects malformed role identifiers and absent accounts', async () => {
    const f = await fixture();
    await expect(f.service.setUserRoles(f.user.id, [''])).rejects.toThrow();
    await expect(f.service.setUserRoles('absent', ['reader'])).rejects.toBeInstanceOf(NotFoundException);
    expect(f.bus.publish).not.toHaveBeenCalled();
  });

  it('propagates a failed binding transaction without publishing authorization success', async () => {
    const f = await fixture();
    const failure = new Error('synthetic transaction failure');
    vi.spyOn(f.db, '$transaction').mockRejectedValueOnce(failure);
    await expect(f.service.setUserRoles(f.user.id, ['reader'])).rejects.toBe(failure);
    expect(f.bus.publish).not.toHaveBeenCalled();
  });
  it('deletes only explicitly selected relations and publishes after success', async () => {
    const f = await fixture();
    await f.db.model('userRoles').create({ data: { userId: f.user.id, roleId: 'reader' } });
    await f.db.model('customGrants').create({ data: { userId: f.user.id } });
    const model = f.db.model.bind(f.db);
    vi.spyOn(f.db, 'model').mockImplementation(name => {
      if (name === 'dimensionUsers') throw new Error('No dimension schema');
      return model(name);
    });
    expect(await f.service.deleteUser(f.user.id, ['userRoles', 'customGrants'])).toBe(true);
    expect(await f.service.findById(f.user.id)).toBeNull();
    expect(await model('userRoles').count()).toBe(0);
    expect(await model('customGrants').count()).toBe(0);
    expect(f.bus.publish).toHaveBeenCalledWith(AUTH_EVENT_TOPICS.USER_DELETED, expect.objectContaining({ userId: f.user.id }));
  });

  it('propagates failed relation cleanup without deleting the account or emitting success', async () => {
    const f = await fixture();
    const failure = new Error('synthetic grant cleanup failure');
    const transaction = f.db.$transaction.bind(f.db);
    vi.spyOn(f.db, '$transaction').mockImplementation(work => transaction(tx => {
      const model = tx.model.bind(tx);
      vi.spyOn(tx, 'model').mockImplementation(name => {
        const delegate = model(name);
        if (name === 'userPermissions') vi.spyOn(delegate, 'deleteMany').mockRejectedValueOnce(failure);
        return delegate;
      });
      return work(tx);
    }));
    await expect(f.service.deleteUser(f.user.id, ['userPermissions'])).rejects.toBe(failure);
    expect(await f.service.findById(f.user.id)).not.toBeNull();
    expect(f.bus.publish).not.toHaveBeenCalled();
  });

  it('requires an explicit related-model contract before any account mutation', async () => {
    const f = await fixture();
    await expect(f.service.deleteUser(f.user.id, undefined as unknown as string[])).rejects.toBeInstanceOf(ValidationException);
    expect(await f.service.findById(f.user.id)).not.toBeNull();
    expect(f.bus.publish).not.toHaveBeenCalled();
  });

});

describe('UserService.addUser passwordless and transactional creation', () => {
  function setup() {
    const db = new InMemoryAdapter();
    const encoder = new ScryptEncoder();
    const bus = { publish: vi.fn().mockResolvedValue(undefined) };
    const service = new UserService(db, encoder, bus);
    return { db, encoder, bus, service };
  }

  it('creates a passwordless account with a null credential and publishes the created event', async () => {
    const f = setup();
    const encode = vi.spyOn(f.encoder, 'encode');
    const user = await f.service.addUser({ username: 'member_one', name: 'Member', typeId: 'member' }, { passwordless: true });
    expect(user.password).toBeNull();
    expect((await f.service.findById(user.id))?.password).toBeNull();
    expect(encode).not.toHaveBeenCalled();
    expect(f.bus.publish).toHaveBeenCalledWith(AUTH_EVENT_TOPICS.USER_CREATED, expect.objectContaining({ userId: user.id }));
    expect(await f.service.findByUsernameAndPassword('member_one', '')).toBeNull();
  });

  it('still requires a valid password by default', async () => {
    const f = setup();
    await expect(f.service.addUser({ username: 'member_two', name: 'Member', typeId: 'member' })).rejects.toBeInstanceOf(ValidationException);
    expect(await f.service.findByUsername('member_two')).toBeNull();
    expect(f.bus.publish).not.toHaveBeenCalled();
  });

  it('rejects a password combined with passwordless and keeps username validation and uniqueness', async () => {
    const f = setup();
    await expect(f.service.addUser({ username: 'member_three', name: 'M', typeId: 'member', password: 'SyntheticOnly9Password' }, { passwordless: true }))
      .rejects.toBeInstanceOf(ValidationException);
    await expect(f.service.addUser({ username: '', name: 'M', typeId: 'member' }, { passwordless: true })).rejects.toBeInstanceOf(ValidationException);
    await f.service.addUser({ username: 'member_three', name: 'M', typeId: 'member' }, { passwordless: true });
    await expect(f.service.addUser({ username: 'member_three', name: 'M', typeId: 'member' }, { passwordless: true }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('writes on the caller transaction and publishes only after it commits', async () => {
    const f = setup();
    const created = await f.db.$transaction(async tx => {
      const model = vi.spyOn(tx, 'model');
      const user = await f.service.addUser({ username: 'member_four', name: 'M', typeId: 'member' }, { passwordless: true, transaction: tx });
      expect(model).toHaveBeenCalledWith('users');
      expect(f.bus.publish).not.toHaveBeenCalled();
      return user;
    });
    expect(f.bus.publish).toHaveBeenCalledTimes(1);
    expect(f.bus.publish).toHaveBeenCalledWith(AUTH_EVENT_TOPICS.USER_CREATED, expect.objectContaining({ userId: created.id }));
  });

  it('does not publish the created event when the caller transaction rolls back', async () => {
    const f = setup();
    const failure = new Error('synthetic later failure');
    await expect(f.db.$transaction(async tx => {
      await f.service.addUser({ username: 'member_five', name: 'M', typeId: 'member' }, { passwordless: true, transaction: tx });
      throw failure;
    })).rejects.toBe(failure);
    expect(f.bus.publish).not.toHaveBeenCalled();
  });
});
