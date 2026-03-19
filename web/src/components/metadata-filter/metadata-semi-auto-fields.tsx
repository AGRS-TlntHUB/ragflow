import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useBuildSwitchOperatorOptions } from '@/hooks/logic-hooks/use-build-operator-options';
import { useFetchKnowledgeMetadata } from '@/hooks/use-knowledge-request';
import { Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { SelectWithSearch } from '../originui/select-with-search';

export function MetadataSemiAutoFields({
  kbIds,
  prefix = '',
}: {
  kbIds: string[];
  prefix?: string;
}) {
  const { t } = useTranslation();
  const form = useFormContext();
  const name = prefix + 'meta_data_filter.semi_auto';
  const restrictFormatName = prefix + 'meta_data_filter.restrict_format';
  const metadata = useFetchKnowledgeMetadata(kbIds);

  const { fields, remove, append, replace } = useFieldArray({
    name,
    control: form.control,
  });
  const restrictFormat = useWatch({
    control: form.control,
    name: restrictFormatName,
  });

  useEffect(() => {
    const values = form.getValues(name) || [];
    if (
      values.some((item: string | { key?: string }) => typeof item === 'string')
    ) {
      replace(
        values.map(
          (item: string | { key?: string; op?: string; format?: string }) =>
            typeof item === 'string' ? { key: item, op: '', format: '' } : item,
        ),
      );
    }
  }, [form, name, replace]);

  const add = useCallback(() => {
    append({ key: '', op: '', format: '' });
  }, [append]);

  const switchOperatorOptions = useBuildSwitchOperatorOptions();

  const autoOption = { label: t('chat.meta.auto'), value: '' };

  const metadataOptions = useMemo(() => {
    return Object.keys(metadata.data || {}).map((key) => ({
      label: key,
      value: key,
    }));
  }, [metadata.data]);

  return (
    <section className="flex flex-col gap-2">
      <FormField
        control={form.control}
        name={restrictFormatName}
        render={({ field }) => (
          <FormItem className="flex items-center gap-2">
            <FormControl>
              <Checkbox
                checked={!!field.value}
                onCheckedChange={(checked) => field.onChange(checked === true)}
                className="size-4"
              />
            </FormControl>
            <FormLabel className="text-sm font-normal">
              {t('chat.restrictMetadataValueFormat', {
                defaultValue: 'Restrict metadata value format',
              })}
            </FormLabel>
          </FormItem>
        )}
      />
      <div className="flex items-center justify-between">
        <FormLabel>{t('chat.metadataKeys')}</FormLabel>
        <Button
          variant={'outline'}
          type="button"
          size="sm"
          onClick={add}
          className="h-8"
        >
          <Plus className="mr-2 size-4" />
          {t('common.add')}
        </Button>
      </div>
      <div className="space-y-2">
        {fields.map((field, index) => {
          const keyField = `${name}.${index}.key`;
          const opField = `${name}.${index}.op`;
          const formatField = `${name}.${index}.format`;
          return (
            <section key={field.id} className="space-y-2">
              <div className="flex items-start gap-2">
                <FormField
                  control={form.control}
                  name={keyField}
                  render={({ field }) => (
                    <FormItem className="flex-[2] overflow-hidden">
                      <FormControl>
                        <SelectWithSearch
                          {...field}
                          options={metadataOptions}
                          placeholder={t('common.pleaseSelect')}
                          triggerClassName="bg-bg-input"
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={opField}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <SelectWithSearch
                          {...field}
                          options={[autoOption, ...switchOperatorOptions]}
                          triggerClassName="bg-bg-input"
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  variant={'ghost'}
                  size="icon"
                  type="button"
                  onClick={() => remove(index)}
                  className="mt-0 h-8 w-10"
                >
                  <X className="size-4 text-text-sub-title-invert" />
                </Button>
              </div>
              {restrictFormat && (
                <FormField
                  control={form.control}
                  name={formatField}
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ''}
                          className="bg-bg-input"
                          placeholder={t(
                            'chat.metadataValueFormatPlaceholder',
                            {
                              defaultValue:
                                'Format, e.g. <PREFIX> <NNN>/<YYYY> or [A-Z]{2,4} [0-9]{3}/[0-9]{4}',
                            },
                          )}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
