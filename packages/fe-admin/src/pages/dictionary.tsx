import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../components/button';
import { EmptyState, toast } from '../components/feedback';
import { FormDialog } from '../components/form';
import { PageContainer, Panel } from '../components/layout';
import { ResourceTable, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { BatchDeleteButton, DeleteAction, crudLoader, enc } from './shared';

interface DictType {
  id: string;
  name: string;
  classified: string;
  describe?: string | null;
}
interface DictItem {
  id: string;
  dictId: string;
  text: string;
  value: unknown;
  ordinal?: number;
}

/** Dictionary types and their items (`/dictionary`, `/dictionary-item`). */
export function DictionaryPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const can = usePermissionCheck();
  const codes = config.permissions.dictionary;
  const typesPath = config.endpoints.dictionary;
  const itemsPath = config.endpoints.dictionaryItems;
  const typeTable = useRef<ResourceTableHandle>(null);
  const itemTable = useRef<ResourceTableHandle>(null);
  const [type, setType] = useState<DictType | null>(null);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [editingType, setEditingType] = useState<DictType | 'new' | null>(null);
  const [editingItem, setEditingItem] = useState<DictItem | 'new' | null>(null);
  const select = (row: DictType | null) => {
    setSelectedItems([]);
    setType(row);
  };
  const typeRecord = editingType && editingType !== 'new' ? editingType : null;
  const itemRecord = editingItem && editingItem !== 'new' ? editingItem : null;
  return (
    <PageContainer title={t('page.dictionary')}>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title={t('dictionary.types')}>
          <ResourceTable<DictType>
            ref={typeTable}
            label={t('dictionary.types')}
            load={crudLoader(api, typesPath)}
            rowKey={(row) => row.id}
            pageSize={10}
            isRowActive={(row) => row.id === type?.id}
            onRowClick={select}
            toolbar={
              can(codes.add) && (
                <Button variant="primary" icon={<Plus />} onClick={() => setEditingType('new')}>
                  {t('common.create')}
                </Button>
              )
            }
            columns={[
              { key: 'name', title: t('dictionary.typeName'), field: 'name' },
              { key: 'classified', title: t('dictionary.classified'), field: 'classified' },
            ]}
            actions={(row) => (
              <>
                <Button size="sm" variant="ghost" onClick={() => select(row)}>
                  {t('dictionary.viewItems')}
                </Button>
                {can(codes.update) && (
                  <Button size="sm" variant="ghost" onClick={() => setEditingType(row)}>
                    {t('common.edit')}
                  </Button>
                )}
                {can(codes.delete) && (
                  <DeleteAction
                    onDelete={async () => {
                      await api.delete(`${typesPath}/${enc(row.id)}`);
                      if (type?.id === row.id) select(null);
                      typeTable.current?.reload();
                    }}
                  />
                )}
              </>
            )}
          />
        </Panel>
        <Panel title={type ? `${type.name} — ${t('dictionary.items')}` : t('dictionary.items')}>
          {type ? (
            <ResourceTable<DictItem>
              key={type.id}
              ref={itemTable}
              label={t('dictionary.items')}
              load={crudLoader(api, itemsPath, () => ({ dictId: type.id }))}
              rowKey={(row) => row.id}
              selection={can(codes.delete) ? { selected: selectedItems, onChange: setSelectedItems } : undefined}
              toolbar={
                <>
                  {can(codes.delete) && (
                    <BatchDeleteButton
                      api={api}
                      path={itemsPath}
                      ids={selectedItems}
                      onDone={() => {
                        setSelectedItems([]);
                        itemTable.current?.reload();
                      }}
                    />
                  )}
                  {can(codes.add) && (
                    <Button variant="primary" icon={<Plus />} onClick={() => setEditingItem('new')}>
                      {t('common.create')}
                    </Button>
                  )}
                </>
              }
              columns={[
                { key: 'text', title: t('dictionary.text'), field: 'text' },
                { key: 'value', title: t('dictionary.value'), render: (row) => String(row.value ?? '') },
                { key: 'ordinal', title: t('dictionary.ordinal'), field: 'ordinal' },
              ]}
              actions={(row) => (
                <>
                  {can(codes.update) && (
                    <Button size="sm" variant="ghost" onClick={() => setEditingItem(row)}>
                      {t('common.edit')}
                    </Button>
                  )}
                  {can(codes.delete) && (
                    <DeleteAction
                      onDelete={async () => {
                        await api.delete(`${itemsPath}/${enc(row.id)}`);
                        itemTable.current?.reload();
                      }}
                    />
                  )}
                </>
              )}
            />
          ) : (
            <EmptyState>{t('dictionary.selectType')}</EmptyState>
          )}
        </Panel>
      </div>
      <FormDialog
        open={editingType !== null}
        onOpenChange={(open) => !open && setEditingType(null)}
        title={typeRecord ? t('dictionary.editType') : t('dictionary.createType')}
        initialValues={{ name: typeRecord?.name ?? '', classified: typeRecord?.classified ?? '', describe: typeRecord?.describe ?? '' }}
        fields={[
          { name: 'name', label: t('dictionary.typeName'), required: true },
          { name: 'classified', label: t('dictionary.classified'), required: true },
          { name: 'describe', label: t('dictionary.describe') },
        ]}
        onSubmit={async (values) => {
          if (typeRecord) {
            await api.put(`${typesPath}/${enc(typeRecord.id)}`, values);
            if (type?.id === typeRecord.id) setType({ ...typeRecord, ...(values as Partial<DictType>) });
          } else await api.post(typesPath, values);
          toast.success(t('common.saved'));
          typeTable.current?.reload();
        }}
      />
      {type && (
        <FormDialog
          open={editingItem !== null}
          onOpenChange={(open) => !open && setEditingItem(null)}
          title={itemRecord ? t('dictionary.editItem') : t('dictionary.createItem')}
          initialValues={{
            text: itemRecord?.text ?? '',
            value: itemRecord?.value != null ? String(itemRecord.value) : '',
            ordinal: String(itemRecord?.ordinal ?? 0),
          }}
          fields={[
            { name: 'text', label: t('dictionary.text'), required: true },
            { name: 'value', label: t('dictionary.value'), required: true },
            { name: 'ordinal', label: t('dictionary.ordinal'), type: 'integer' },
          ]}
          onSubmit={async (values) => {
            const body = { text: values.text, value: values.value, ordinal: Number(values.ordinal ?? 0) };
            if (itemRecord) await api.put(`${itemsPath}/${enc(itemRecord.id)}`, body);
            else await api.post(itemsPath, { ...body, dictId: type.id });
            toast.success(t('common.saved'));
            itemTable.current?.reload();
          }}
        />
      )}
    </PageContainer>
  );
}
