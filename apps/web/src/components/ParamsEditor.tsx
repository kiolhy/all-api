import { useState } from 'react';
import { Checkbox, JsonEditor, Select, TextInput } from './Field.tsx';
import { PARAM_LOCATIONS, PARAM_LOCATION_LABEL, PARAM_TYPES } from '../types.ts';
import type { Param, ParamLocation, ParamType } from '../types.ts';

function parseList(raw: string): Param[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as Param[];
  } catch {
    return null;
  }
}

const BLANK: Param = {
  name: '',
  in: 'query',
  type: 'string',
  required: false,
  description: '',
};

/**
 * 参数表编辑器。
 * 默认是逐行表单（名称/位置/类型/必填/说明/密钥），
 * 「高级」里才暴露原始 JSON，日常不用碰。
 */
export function ParamsEditor({
  value,
  error,
  onChange,
}: {
  value: string;
  error?: string;
  onChange: (next: string) => void;
}) {
  const list = parseList(value);
  const [advanced, setAdvanced] = useState(false);
  const broken = list === null;

  const write = (next: Param[]) => onChange(JSON.stringify(next, null, 2));

  const patch = (index: number, change: Partial<Param>) => {
    const base = list ?? [];
    write(base.map((item, i) => (i === index ? { ...item, ...change } : item)));
  };

  const removeAt = (index: number) => {
    write((list ?? []).filter((_, i) => i !== index));
  };

  const addRow = () => {
    write([...(list ?? []), { ...BLANK }]);
  };

  return (
    <div className="params-editor">
      <div className="params-editor-head">
        <div>
          <div className="sub-title">参数（{list?.length ?? 0}）</div>
          <div className="dim small">
            只声明这里出现过的参数才会被网关接受，别的键会被直接拒掉。
          </div>
        </div>
        <div className="params-editor-head-actions">
          <button type="button" className="btn sm ghost" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? '用表单编辑' : '高级（JSON）'}
          </button>
          {advanced || broken ? null : (
            <button type="button" className="btn sm" onClick={addRow}>
              + 添加参数
            </button>
          )}
        </div>
      </div>

      {broken ? (
        <div className="notice warn">
          params 不是合法的 JSON 数组，先在这里改对，再切回表单编辑。
        </div>
      ) : null}

      {advanced || broken ? (
        <JsonEditor
          value={value}
          rows={8}
          error={error}
          onChange={onChange}
          placeholder={`[{"name":"id","in":"path","type":"string","required":true,"description":"用户 ID"}]`}
        />
      ) : list && list.length > 0 ? (
        <div className="param-rows">
          <div className="param-row param-row-head">
            <span>名称</span>
            <span>位置</span>
            <span>类型</span>
            <span>必填</span>
            <span>说明</span>
            <span>密钥引用</span>
            <span />
          </div>
          {list.map((param, index) => (
            <div className="param-row" key={`${param.name}-${index}`}>
              <TextInput
                mono
                value={param.name}
                onChange={(event) => patch(index, { name: event.target.value })}
                placeholder="id"
              />
              <Select
                value={param.in}
                onChange={(event) =>
                  patch(index, { in: event.target.value as ParamLocation })
                }
              >
                {PARAM_LOCATIONS.map((location) => (
                  <option key={location} value={location}>
                    {PARAM_LOCATION_LABEL[location]}
                  </option>
                ))}
              </Select>
              <Select
                value={param.type}
                onChange={(event) => patch(index, { type: event.target.value as ParamType })}
              >
                {PARAM_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
              <div className="param-cell-check">
                <Checkbox
                  checked={param.required}
                  onChange={(next) => patch(index, { required: next })}
                />
              </div>
              <TextInput
                value={param.description ?? ''}
                onChange={(event) => patch(index, { description: event.target.value })}
                placeholder="这个参数是干什么的"
              />
              <TextInput
                mono
                value={param.secretRef ?? ''}
                onChange={(event) =>
                  patch(index, { secretRef: event.target.value || undefined })
                }
                placeholder="可选"
              />
              <button
                type="button"
                className="btn sm danger-ghost param-remove"
                title="删除这个参数"
                onClick={() => removeAt(index)}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty small">还没有参数。不需要参数的接口可以留空。</div>
      )}

      {error && !broken && !advanced ? <div className="field-error">{error}</div> : null}
    </div>
  );
}
