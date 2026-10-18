'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FormProvider, useForm, type FieldErrors } from 'react-hook-form';
import { Landmark, Save, Shield, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { Config } from '@/lib/types';
import { configFormSchema, createConfigResolver } from '@/lib/config/form';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ExchangeTab } from '@/components/config-form/ExchangeTab';
import { GlobalTab } from '@/components/config-form/GlobalTab';
import { SymbolsTab } from '@/components/config-form/SymbolsTab';
import { buildInitialConfig, collectErrors, describePath, firstInvalid, type ConfigTab } from '@/components/config-form/form-state';

// The bot's configuration form: react-hook-form holds the config, Zod (lib/config/form.ts, derived from the schema
// /api/config validates with) decides whether it may be saved, and the fields are shadcn Fields (config-form/).
// What Save hands to onSave is the whole config as it will be posted: the loaded config with the user's edits.

export { hedgePositionModeAvailable, lighterHedgeConfigured } from '@/components/config-form/form-state';

interface SymbolConfigFormProps {
  onSave: (config: Config) => void | Promise<void>;
  currentConfig?: Config;
}

export default function SymbolConfigForm({ onSave, currentConfig }: SymbolConfigFormProps) {
  // The form starts from the config it is given; later changes of the prop are not taken over
  const [initialConfig] = useState(() => buildInitialConfig(currentConfig));
  const resolver = useMemo(() => createConfigResolver<Config>(configFormSchema, initialConfig), [initialConfig]);
  const form = useForm<Config>({
    resolver,
    defaultValues: initialConfig,
    mode: 'onChange',
    // Focusing is done below, after the tab and the symbol holding the invalid field are shown
    shouldFocusError: false,
  });

  const [tab, setTab] = useState<ConfigTab>('api');
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [refusedSaves, setRefusedSaves] = useState(0);
  const formRef = useRef<HTMLDivElement>(null);

  // After a refused save, once the tab and symbol holding the invalid fields are shown: focus the first of them
  // on the page (fields with an error carry aria-invalid). A tab mounts its content a render after it is selected.
  useEffect(() => {
    if (refusedSaves === 0) return;
    const timer = setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
    return () => clearTimeout(timer);
  }, [refusedSaves]);

  // Save was refused: show the first invalid field and say so
  const handleInvalid = (errors: FieldErrors<Config>) => {
    const first = firstInvalid(errors);
    if (!first) return;
    const count = collectErrors(errors).length;
    setTab(first.tab);
    if (first.symbol) setSelectedSymbol(first.symbol);
    setRefusedSaves((refused) => refused + 1);
    toast.error('Cannot save yet: fix the highlighted fields', {
      description: count === 1 ? `${describePath(first.path)}: ${first.message}` : `${count} fields need attention`,
    });
  };

  const handleSave = form.handleSubmit(async (config) => {
    await onSave(config);
  }, handleInvalid);

  return (
    <FormProvider {...form}>
      <div ref={formRef} className="space-y-6">
        <Tabs value={tab} onValueChange={(value) => setTab(value as ConfigTab)} className="space-y-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="api" className="flex items-center gap-2">
              <Landmark className="h-4 w-4" />
              Exchange
            </TabsTrigger>
            <TabsTrigger value="global" className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Global Settings
            </TabsTrigger>
            <TabsTrigger value="symbols" className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Symbols
            </TabsTrigger>
          </TabsList>

          <TabsContent value="api" className="space-y-4">
            <ExchangeTab />
          </TabsContent>

          <TabsContent value="global" className="space-y-4">
            <GlobalTab />
          </TabsContent>

          <TabsContent value="symbols" className="space-y-4">
            <SymbolsTab selectedSymbol={selectedSymbol} onSelectSymbol={setSelectedSymbol} />
          </TabsContent>
        </Tabs>

        <div className="flex justify-end">
          <Button type="button" onClick={() => void handleSave()} size="lg" className="flex items-center gap-2">
            <Save className="h-4 w-4" />
            Save Configuration
          </Button>
        </div>
      </div>
    </FormProvider>
  );
}
