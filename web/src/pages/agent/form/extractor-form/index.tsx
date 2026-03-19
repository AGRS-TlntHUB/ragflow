import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { LargeModelFormField } from '@/components/large-model-form-field';
import { LlmSettingSchema } from '@/components/llm-setting-items/next';
import { SelectWithSearch } from '@/components/originui/select-with-search';
import { RAGFlowFormItem } from '@/components/ragflow-form';
import { BlockButton, Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PromptEditor } from '@/pages/agent/form/components/prompt-editor';
import { buildOptions } from '@/utils/form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { memo, useEffect } from 'react';
import { useFieldArray, useForm, useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  ContextGeneratorFieldName,
  ExtractorMode,
  initialExtractorValues,
} from '../../constant/pipeline';
import { useBuildNodeOutputOptions } from '../../hooks/use-build-options';
import { useFormValues } from '../../hooks/use-form-values';
import { useWatchFormChange } from '../../hooks/use-watch-form-change';
import { INextOperatorForm } from '../../interface';
import { buildOutputList } from '../../utils/build-output-list';
import { FormWrapper } from '../components/form-wrapper';
import { Output } from '../components/output';
import { useSwitchPrompt } from './use-switch-prompt';

export const FormSchema = z.object({
  field_name: z.string(),
  mode: z.enum([ExtractorMode.LanguageModel, ExtractorMode.RegularExpressions]),
  title_page_only: z.boolean().optional(),
  sys_prompt: z.string().optional(),
  prompts: z.string().optional(),
  keyword_regexes: z
    .array(
      z.object({
        expression: z.string().refine(
          (val) => {
            if (!val) return true;
            try {
              new RegExp(val);
              return true;
            } catch {
              return false;
            }
          },
          { message: 'Must be a valid regular expression string' },
        ),
      }),
    )
    .optional(),
  metadata_regexes: z
    .array(
      z.object({
        key: z.string(),
        expressions: z.array(
          z.object({
            expression: z.string().refine(
              (val) => {
                if (!val) return true;
                try {
                  new RegExp(val);
                  return true;
                } catch {
                  return false;
                }
              },
              { message: 'Must be a valid regular expression string' },
            ),
          }),
        ),
      }),
    )
    .optional(),
  ...LlmSettingSchema,
});

export type ExtractorFormSchemaType = z.infer<typeof FormSchema>;

const outputList = buildOutputList(initialExtractorValues.outputs);

const RegexEnabledFields = new Set([
  ContextGeneratorFieldName.Metadata,
  ContextGeneratorFieldName.Keywords,
]);

type MetadataRegexesProps = {
  index: number;
  parentName: string;
  removeParent: (index: number) => void;
  isLatest: boolean;
};

function MetadataRegexes({
  index,
  parentName,
  removeParent,
  isLatest,
}: MetadataRegexesProps) {
  const { t } = useTranslation();
  const form = useFormContext<ExtractorFormSchemaType>();
  const name = `${parentName}.${index}.expressions` as const;
  const { fields, append, remove } = useFieldArray({
    name,
    control: form.control,
  });

  return (
    <Card>
      <CardHeader className="flex-row justify-between items-center">
        <div className="flex-1 pr-2">
          <RAGFlowFormItem
            name={`${parentName}.${index}.key`}
            label={t('flow.metadataField')}
            className="!space-y-0"
          >
            <Input className="!m-0" />
          </RAGFlowFormItem>
        </div>
        {isLatest && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => removeParent(index)}
          >
            <Trash2 />
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {fields.map((field, expressionIndex) => (
          <div key={field.id} className="flex items-center gap-2">
            <RAGFlowFormItem
              name={`${name}.${expressionIndex}.expression`}
              label={t('flow.regularExpressions')}
              labelClassName="!hidden"
              className="flex-1 !space-y-0"
            >
              <Input className="!m-0" />
            </RAGFlowFormItem>
            {expressionIndex === 0 ? (
              <Button
                type="button"
                onClick={() => append({ expression: '' })}
                variant="ghost"
              >
                <Plus />
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => remove(expressionIndex)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function KeywordRegexes() {
  const { t } = useTranslation();
  const form = useFormContext<ExtractorFormSchemaType>();
  const name = 'keyword_regexes' as const;
  const { fields, append, remove } = useFieldArray({
    name,
    control: form.control,
  });

  return (
    <section className="space-y-4">
      {fields.map((field, index) => (
        <div key={field.id} className="flex items-center gap-2">
          <RAGFlowFormItem
            name={`${name}.${index}.expression`}
            label={t('flow.regularExpressions')}
            labelClassName="!hidden"
            className="flex-1 !space-y-0"
          >
            <Input className="!m-0" />
          </RAGFlowFormItem>
          {index === 0 ? (
            <Button
              type="button"
              onClick={() => append({ expression: '' })}
              variant="ghost"
            >
              <Plus />
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => remove(index)}>
              <Trash2 />
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}

const ExtractorForm = ({ node }: INextOperatorForm) => {
  const defaultValues = useFormValues(initialExtractorValues, node);
  const { t } = useTranslation();

  const form = useForm<ExtractorFormSchemaType>({
    defaultValues,
    resolver: zodResolver(FormSchema),
    // mode: 'onChange',
  });

  const promptOptions = useBuildNodeOutputOptions(node?.id);

  const options = buildOptions(ContextGeneratorFieldName, t, 'flow');

  const {
    handleFieldNameChange,
    confirmSwitch,
    hideModal,
    visible,
    cancelSwitch,
  } = useSwitchPrompt(form);

  useWatchFormChange(node?.id, form);

  const fieldName = form.watch('field_name');
  const mode = form.watch('mode');
  const isToc = fieldName === ContextGeneratorFieldName.TableOfContents;
  const regexEnabled = RegexEnabledFields.has(
    fieldName as ContextGeneratorFieldName,
  );
  const isRegexMode = regexEnabled && mode === ExtractorMode.RegularExpressions;
  const showTitlePageOnly =
    isRegexMode ||
    (fieldName === ContextGeneratorFieldName.Metadata &&
      mode === ExtractorMode.LanguageModel);

  const metadataRegexesFieldArray = useFieldArray({
    name: 'metadata_regexes',
    control: form.control,
  });

  useEffect(() => {
    if (!regexEnabled && mode !== ExtractorMode.LanguageModel) {
      form.setValue('mode', ExtractorMode.LanguageModel, { shouldDirty: true });
    }
  }, [form, mode, regexEnabled]);

  useEffect(() => {
    if (
      mode === ExtractorMode.RegularExpressions &&
      fieldName === ContextGeneratorFieldName.Metadata &&
      metadataRegexesFieldArray.fields.length === 0
    ) {
      metadataRegexesFieldArray.append({
        key: '',
        expressions: [{ expression: '' }],
      });
    }
  }, [fieldName, metadataRegexesFieldArray, mode]);

  return (
    <Form {...form}>
      <FormWrapper>
        {!isRegexMode && <LargeModelFormField></LargeModelFormField>}
        <RAGFlowFormItem label={t('flow.fieldName')} name="field_name">
          {(field) => (
            <SelectWithSearch
              onChange={(value) => {
                field.onChange(value);
                if (!isRegexMode) {
                  handleFieldNameChange(value);
                }
              }}
              value={field.value}
              placeholder={t('dataFlowPlaceholder')}
              options={options}
            ></SelectWithSearch>
          )}
        </RAGFlowFormItem>

        {regexEnabled && (
          <RAGFlowFormItem label={t('flow.extractionMode')} name="mode">
            <SelectWithSearch
              options={[
                {
                  label: t('flow.extractorModes.languageModel'),
                  value: ExtractorMode.LanguageModel,
                },
                {
                  label: t('flow.extractorModes.regularExpressions'),
                  value: ExtractorMode.RegularExpressions,
                },
              ]}
            />
          </RAGFlowFormItem>
        )}

        {showTitlePageOnly && (
          <fieldset>
            <div className="mb-2 flex justify-between items-center gap-1">
              <span>{t('flow.titlePageOnly')}</span>
              <FormField
                control={form.control}
                name="title_page_only"
                render={({ field: { value, onChange, ...restProps } }) => (
                  <FormItem>
                    <FormControl>
                      <Switch
                        checked={Boolean(value)}
                        onCheckedChange={onChange}
                        {...restProps}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
          </fieldset>
        )}

        {!isRegexMode && !isToc && (
          <RAGFlowFormItem label={t('flow.systemPrompt')} name="sys_prompt">
            <PromptEditor
              placeholder={t('flow.messagePlaceholder')}
              showToolbar={true}
              baseOptions={promptOptions}
            ></PromptEditor>
          </RAGFlowFormItem>
        )}

        {!isRegexMode ? (
          <RAGFlowFormItem
            label={isToc ? t('flow.tocDataSource') : t('flow.userPrompt')}
            name="prompts"
          >
            <PromptEditor
              showToolbar={true}
              baseOptions={promptOptions}
            ></PromptEditor>
          </RAGFlowFormItem>
        ) : fieldName === ContextGeneratorFieldName.Metadata ? (
          <>
            {metadataRegexesFieldArray.fields.map((field, index) => (
              <MetadataRegexes
                key={field.id}
                parentName="metadata_regexes"
                index={index}
                removeParent={metadataRegexesFieldArray.remove}
                isLatest={index === metadataRegexesFieldArray.fields.length - 1}
              />
            ))}
            <BlockButton
              type="button"
              onClick={() =>
                metadataRegexesFieldArray.append({
                  key: '',
                  expressions: [{ expression: '' }],
                })
              }
            >
              {t('flow.addMetadataField')}
            </BlockButton>
          </>
        ) : (
          <KeywordRegexes />
        )}

        <Output list={outputList}></Output>
      </FormWrapper>
      {visible && (
        <ConfirmDeleteDialog
          title={t('flow.switchPromptMessage')}
          open
          onOpenChange={hideModal}
          onOk={confirmSwitch}
          onCancel={cancelSwitch}
        ></ConfirmDeleteDialog>
      )}
    </Form>
  );
};

export default memo(ExtractorForm);
