/**
 * emit/channel.ts -- the BridgeLink step wrapped in a whole channel.
 *
 * `emit/bridgelink.ts` writes the transformer step and stops: what it hands you
 * is pasted into a channel somebody already built. This file builds the channel
 * around it, so `bun emit.ts bridgelink:channel` is one file you import in the
 * Administrator, and so `bridgelink-check.ts` can deploy the step it is proving
 * without anybody clicking anything.
 *
 * WHAT GOES IN
 *
 *   - Source filter: one JavaScript rule, `filterCondition(spec)`. The gate
 *     belongs in front of the transformer, same as the IRIS routing rule.
 *   - Source transformer: one JavaScript step, `emitBridgelink(spec)`.
 *   - Inbound and outbound data type: HL7 v2.x, non-strict parser. The step is
 *     written against that XML shape and no other, so the channel says so
 *     rather than leaving it to whoever imports it.
 *   - Connectors: a Channel Reader in and a Channel Writer to nowhere, unless
 *     the spec names a listener and a receiver. Those are the only two facts
 *     here a site has to supply, and a channel that imports, deploys and
 *     transforms with neither is the one `bridgelink-check.ts` needs.
 *
 * WHAT DOES NOT
 *
 * Code templates, alerts, pruning and message storage beyond the default. The
 * channel is a starting point that is right about the mapping, not a finished
 * production channel. The header in the step says the same about itself.
 *
 * THE VERSION ATTRIBUTE
 *
 * Every element carries `version="..."`. An export from an older server is
 * migrated on import; one claiming a NEWER version than the server is refused.
 * So the default is deliberately old (4.5.0, the Mirth line BridgeLink forked
 * from) and the harness passes the live server's own version instead.
 */

import { emitBridgelink, filterCondition } from "./bridgelink";
import type { Spec } from "../spec";

/** Where the channel takes messages from and sends them to. */
export interface ChannelOptions {
  /** Channel id. A stable one lets a re-import update rather than duplicate. */
  id: string;
  /** Defaults to `spec.bridgelink.channelName`. */
  name?: string;
  /** Written on every element. See the header. */
  version?: string;
  /** Listen for MLLP on this port. Absent means a Channel Reader. */
  listenPort?: number;
  /** Send MLLP to this host:port. Absent means a Channel Writer to none. */
  sendTo?: { host: string; port: number };
  description?: string;
}

/** XML text content. `&` first, or every entity this adds is escaped again. */
export function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A stable channel id from a name.
 *
 * A channel id is a UUID, and re-importing a channel under a NEW id makes a
 * second channel with the same name, which the Administrator then refuses to
 * deploy beside the first. Deriving the id from the name means emitting twice
 * and importing twice updates one channel. Not a real UUIDv5 -- nothing reads
 * the bits -- just the right shape and the same every time.
 */
export function channelId(name: string): string {
  const h = new Bun.CryptoHasher("sha256").update(`hl7-bench:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function hl7v2Properties(tag: string, v: string): string {
  const p = "com.mirth.connect.plugins.datatypes.hl7v2";
  return `<${tag} class="${p}.HL7v2DataTypeProperties" version="${v}">
  <serializationProperties class="${p}.HL7v2SerializationProperties" version="${v}">
    <handleRepetitions>true</handleRepetitions>
    <handleSubcomponents>true</handleSubcomponents>
    <useStrictParser>false</useStrictParser>
    <useStrictValidation>false</useStrictValidation>
    <stripNamespaces>true</stripNamespaces>
    <segmentDelimiter>\\r</segmentDelimiter>
    <convertLineBreaks>true</convertLineBreaks>
  </serializationProperties>
  <deserializationProperties class="${p}.HL7v2DeserializationProperties" version="${v}">
    <useStrictParser>false</useStrictParser>
    <useStrictValidation>false</useStrictValidation>
    <segmentDelimiter>\\r</segmentDelimiter>
  </deserializationProperties>
  <batchProperties class="${p}.HL7v2BatchProperties" version="${v}">
    <splitType>MSH_Segment</splitType>
    <batchScript></batchScript>
  </batchProperties>
  <responseGenerationProperties class="${p}.HL7v2ResponseGenerationProperties" version="${v}">
    <segmentDelimiter>\\r</segmentDelimiter>
    <successfulACKCode>AA</successfulACKCode>
    <successfulACKMessage></successfulACKMessage>
    <errorACKCode>AE</errorACKCode>
    <errorACKMessage>An Error Occurred Processing Message.</errorACKMessage>
    <rejectedACKCode>AR</rejectedACKCode>
    <rejectedACKMessage>Message Rejected.</rejectedACKMessage>
    <msh15ACKAccept>false</msh15ACKAccept>
    <dateFormat>yyyyMMddHHmmss.SSS</dateFormat>
  </responseGenerationProperties>
  <responseValidationProperties class="${p}.HL7v2ResponseValidationProperties" version="${v}">
    <successfulACKCode>AA,CA</successfulACKCode>
    <errorACKCode>AE,CE</errorACKCode>
    <rejectedACKCode>AR,CR</rejectedACKCode>
    <validateMessageControlId>true</validateMessageControlId>
    <originalMessageControlId>Destination_Encoded</originalMessageControlId>
    <originalIdMapVariable></originalIdMapVariable>
  </responseValidationProperties>
</${tag}>`;
}

function transformer(tag: string, v: string, steps: string): string {
  return `<${tag} version="${v}">
  <elements>${steps}</elements>
  <inboundDataType>HL7V2</inboundDataType>
  <outboundDataType>HL7V2</outboundDataType>
  ${hl7v2Properties("inboundProperties", v)}
  ${hl7v2Properties("outboundProperties", v)}
</${tag}>`;
}

function jsStep(v: string, name: string, script: string): string {
  return `
    <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="${v}">
      <name>${xml(name)}</name>
      <sequenceNumber>0</sequenceNumber>
      <enabled>true</enabled>
      <script>${xml(script)}</script>
    </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>
  `;
}

function jsRule(v: string, name: string, script: string): string {
  return `
    <com.mirth.connect.plugins.javascriptrule.JavaScriptRule version="${v}">
      <name>${xml(name)}</name>
      <sequenceNumber>0</sequenceNumber>
      <enabled>true</enabled>
      <operator>NONE</operator>
      <script>${xml(script)}</script>
    </com.mirth.connect.plugins.javascriptrule.JavaScriptRule>
  `;
}

const RESOURCES = `<resourceIds class="linked-hash-map">
  <entry>
    <string>Default Resource</string>
    <string>[Default Resource]</string>
  </entry>
</resourceIds>`;

function sourceProperties(v: string, o: ChannelOptions): { props: string; transport: string } {
  const common = `<sourceConnectorProperties version="${v}">
    <responseVariable>None</responseVariable>
    <respondAfterProcessing>true</respondAfterProcessing>
    <processBatch>false</processBatch>
    <firstResponse>false</firstResponse>
    <processingThreads>1</processingThreads>
    ${RESOURCES}
    <queueBufferSize>1000</queueBufferSize>
  </sourceConnectorProperties>`;
  if (o.listenPort === undefined) {
    return {
      transport: "Channel Reader",
      props: `<properties class="com.mirth.connect.connectors.vm.VmReceiverProperties" version="${v}">
  <pluginProperties/>
  ${common}
</properties>`,
    };
  }
  return {
    transport: "TCP Listener",
    props: `<properties class="com.mirth.connect.connectors.tcp.TcpReceiverProperties" version="${v}">
  <pluginProperties/>
  <listenerConnectorProperties version="${v}">
    <host>0.0.0.0</host>
    <port>${o.listenPort}</port>
  </listenerConnectorProperties>
  ${common}
  <transmissionModeProperties class="com.mirth.connect.plugins.mllpmode.MLLPModeProperties">
    <pluginPointName>MLLP</pluginPointName>
    <startOfMessageBytes>0B</startOfMessageBytes>
    <endOfMessageBytes>1C0D</endOfMessageBytes>
    <useMLLPv2>false</useMLLPv2>
    <ackBytes>06</ackBytes>
    <nackBytes>15</nackBytes>
    <maxRetries>2</maxRetries>
  </transmissionModeProperties>
  <serverMode>true</serverMode>
  <remoteAddress></remoteAddress>
  <remotePort></remotePort>
  <overrideLocalBinding>false</overrideLocalBinding>
  <reconnectInterval>5000</reconnectInterval>
  <receiveTimeout>0</receiveTimeout>
  <bufferSize>65536</bufferSize>
  <maxConnections>10</maxConnections>
  <keepConnectionOpen>true</keepConnectionOpen>
  <dataTypeBinary>false</dataTypeBinary>
  <charsetEncoding>DEFAULT_ENCODING</charsetEncoding>
  <respondOnNewConnection>0</respondOnNewConnection>
  <responseAddress></responseAddress>
  <responsePort></responsePort>
</properties>`,
  };
}

function destinationProperties(v: string, o: ChannelOptions): { props: string; transport: string } {
  const common = `<destinationConnectorProperties version="${v}">
    <queueEnabled>false</queueEnabled>
    <sendFirst>false</sendFirst>
    <retryIntervalMillis>10000</retryIntervalMillis>
    <regenerateTemplate>false</regenerateTemplate>
    <retryCount>0</retryCount>
    <rotate>false</rotate>
    <includeFilterTransformer>false</includeFilterTransformer>
    <threadCount>1</threadCount>
    <threadAssignmentVariable></threadAssignmentVariable>
    <validateResponse>false</validateResponse>
    ${RESOURCES}
    <queueBufferSize>1000</queueBufferSize>
    <reattachAttachments>true</reattachAttachments>
  </destinationConnectorProperties>`;
  if (o.sendTo === undefined) {
    return {
      transport: "Channel Writer",
      props: `<properties class="com.mirth.connect.connectors.vm.VmDispatcherProperties" version="${v}">
  <pluginProperties/>
  ${common}
  <channelId>none</channelId>
  <channelTemplate>\${message.encodedData}</channelTemplate>
  <mapVariables/>
</properties>`,
    };
  }
  return {
    transport: "TCP Sender",
    props: `<properties class="com.mirth.connect.connectors.tcp.TcpDispatcherProperties" version="${v}">
  <pluginProperties/>
  ${common}
  <transmissionModeProperties class="com.mirth.connect.plugins.mllpmode.MLLPModeProperties">
    <pluginPointName>MLLP</pluginPointName>
    <startOfMessageBytes>0B</startOfMessageBytes>
    <endOfMessageBytes>1C0D</endOfMessageBytes>
    <useMLLPv2>false</useMLLPv2>
    <ackBytes>06</ackBytes>
    <nackBytes>15</nackBytes>
    <maxRetries>2</maxRetries>
  </transmissionModeProperties>
  <serverMode>false</serverMode>
  <remoteAddress>${xml(o.sendTo.host)}</remoteAddress>
  <remotePort>${o.sendTo.port}</remotePort>
  <overrideLocalBinding>false</overrideLocalBinding>
  <localAddress>0.0.0.0</localAddress>
  <localPort>0</localPort>
  <sendTimeout>5000</sendTimeout>
  <bufferSize>65536</bufferSize>
  <maxConnections>1</maxConnections>
  <keepConnectionOpen>false</keepConnectionOpen>
  <checkRemoteHost>false</checkRemoteHost>
  <responseTimeout>5000</responseTimeout>
  <ignoreResponse>false</ignoreResponse>
  <queueOnResponseTimeout>true</queueOnResponseTimeout>
  <dataTypeBinary>false</dataTypeBinary>
  <charsetEncoding>DEFAULT_ENCODING</charsetEncoding>
  <template>\${message.encodedData}</template>
</properties>`,
  };
}

/** The whole channel, as the Administrator's Import Channel expects it. */
export function emitChannel(spec: Spec, o: ChannelOptions): string {
  const v = o.version ?? "4.5.0";
  const name = o.name ?? spec.bridgelink?.channelName ?? spec.name;
  const step = emitBridgelink(spec);
  const gate = filterCondition(spec);
  // An upstream gate prints as a comment, not a rule. A rule whose script is a
  // comment returns undefined, which the filter reads as "reject everything".
  const rules = spec.gate.enabled === false ? "" : jsRule(v, "hl7-bench gate", gate);
  const src = sourceProperties(v, o);
  const dst = destinationProperties(v, o);
  const description =
    o.description ??
    `Generated by hl7-bench from spec "${spec.name}". Regenerate rather than hand-edit the step.`;

  return `<channel version="${v}">
  <id>${xml(o.id)}</id>
  <nextMetaDataId>2</nextMetaDataId>
  <name>${xml(name)}</name>
  <description>${xml(description)}</description>
  <revision>1</revision>
  <sourceConnector version="${v}">
    <metaDataId>0</metaDataId>
    <name>sourceConnector</name>
    ${src.props}
    ${transformer("transformer", v, jsStep(v, "hl7-bench transform", step))}
    <filter version="${v}">
      <elements>${rules}</elements>
    </filter>
    <transportName>${src.transport}</transportName>
    <mode>SOURCE</mode>
    <enabled>true</enabled>
    <waitForPrevious>true</waitForPrevious>
  </sourceConnector>
  <destinationConnectors>
    <connector version="${v}">
      <metaDataId>1</metaDataId>
      <name>Destination 1</name>
      ${dst.props}
      ${transformer("transformer", v, "")}
      ${transformer("responseTransformer", v, "")}
      <filter version="${v}">
        <elements/>
      </filter>
      <transportName>${dst.transport}</transportName>
      <mode>DESTINATION</mode>
      <enabled>true</enabled>
      <waitForPrevious>true</waitForPrevious>
    </connector>
  </destinationConnectors>
  <preprocessingScript>return message;</preprocessingScript>
  <postprocessingScript>return;</postprocessingScript>
  <deployScript>return;</deployScript>
  <undeployScript>return;</undeployScript>
  <properties version="${v}">
    <clearGlobalChannelMap>true</clearGlobalChannelMap>
    <messageStorageMode>DEVELOPMENT</messageStorageMode>
    <encryptData>false</encryptData>
    <encryptAttachments>false</encryptAttachments>
    <encryptCustomMetaData>false</encryptCustomMetaData>
    <removeContentOnCompletion>false</removeContentOnCompletion>
    <removeOnlyFilteredOnCompletion>false</removeOnlyFilteredOnCompletion>
    <removeAttachmentsOnCompletion>false</removeAttachmentsOnCompletion>
    <initialState>STARTED</initialState>
    <storeAttachments>false</storeAttachments>
    <metaDataColumns/>
    <attachmentProperties version="${v}">
      <type>None</type>
      <properties/>
    </attachmentProperties>
    ${RESOURCES}
  </properties>
</channel>
`;
}
